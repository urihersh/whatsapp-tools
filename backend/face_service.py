import base64
import shutil
import numpy as np
import cv2
from pathlib import Path

_fa = None  # insightface app singleton


def _get_model():
    global _fa
    if _fa is None:
        from insightface.app import FaceAnalysis
        _fa = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
        _fa.prepare(ctx_id=0, det_size=(640, 640))
    return _fa


def _largest_face(faces: list):
    """Return the face with the largest bounding box area."""
    return max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))


class FaceService:
    def __init__(self, data_dir: str):
        self.kids_dir = Path(data_dir) / "kids"
        self.kids_dir.mkdir(parents=True, exist_ok=True)
        self._cache: dict[str, list] = {}  # kid_id -> [embeddings]

    # ── Directory helpers ──────────────────────────────────────────────────────

    def kid_dir(self, kid_id: str) -> Path:
        d = self.kids_dir / kid_id
        d.mkdir(parents=True, exist_ok=True)
        return d

    def emb_dir(self, kid_id: str) -> Path:
        d = self.kid_dir(kid_id) / "embeddings"
        d.mkdir(exist_ok=True)
        return d

    def enrolled_dir(self, kid_id: str) -> Path:
        d = self.kid_dir(kid_id) / "enrolled"
        d.mkdir(exist_ok=True)
        return d

    # ── Image helpers ──────────────────────────────────────────────────────────

    def _read(self, path: str) -> np.ndarray:
        img = cv2.imread(path)
        if img is None:
            raise ValueError(f"Could not read image: {path}")
        return img

    def detect_faces(self, image_path: str) -> list:
        try:
            return _get_model().get(self._read(image_path))
        except Exception:
            return []

    def detect_faces_with_image(self, image_path: str) -> tuple[list, np.ndarray | None]:
        """Return (faces, img) in one read — avoids re-reading the file for subsequent ops."""
        try:
            img = self._read(image_path)
            return _get_model().get(img), img
        except Exception:
            return [], None

    def get_face_crop_b64_from_array(self, img: np.ndarray, faces: list) -> str | None:
        """Crop the largest face from an already-loaded image with already-detected faces."""
        try:
            x1, y1, x2, y2 = [max(0, int(v)) for v in _largest_face(faces).bbox]
            _, buf = cv2.imencode(".jpg", img[y1:y2, x1:x2])
            return base64.b64encode(buf.tobytes()).decode()
        except Exception:
            return None

    def classify_face_quality(self, faces: list, img: np.ndarray) -> tuple[float, str]:
        """Return (face_size_ratio, quality) for the largest detected face."""
        bbox = _largest_face(faces).bbox
        face_area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
        img_area = img.shape[0] * img.shape[1]
        ratio = round(face_area / img_area, 3)
        if ratio < 0.02:
            return ratio, "small"
        if ratio < 0.05:
            return ratio, "ok"
        return ratio, "good"

    def get_face_crop_b64(self, image_path: str) -> str | None:
        try:
            img = self._read(image_path)
            faces = _get_model().get(img)
            if not faces:
                return None
            x1, y1, x2, y2 = [max(0, int(v)) for v in _largest_face(faces).bbox]
            _, buf = cv2.imencode(".jpg", img[y1:y2, x1:x2])
            return base64.b64encode(buf.tobytes()).decode()
        except Exception:
            return None

    # ── Enrollment ─────────────────────────────────────────────────────────────

    def enroll_photo(self, image_path: str, photo_id: str, kid_id: str) -> dict:
        try:
            faces = _get_model().get(self._read(image_path))
            if not faces:
                return {"success": False, "error": "No face detected"}
            np.save(str(self.emb_dir(kid_id) / f"{photo_id}.npy"), _largest_face(faces).normed_embedding)
            self._cache.pop(kid_id, None)
            return {"success": True, "photo_id": photo_id}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def remove_enrollment(self, photo_id: str, kid_id: str) -> bool:
        emb = self.emb_dir(kid_id) / f"{photo_id}.npy"
        removed = emb.exists()
        emb.unlink(missing_ok=True)
        for ext in [".jpg", ".jpeg", ".png", ".webp"]:
            (self.enrolled_dir(kid_id) / f"{photo_id}{ext}").unlink(missing_ok=True)
        self._cache.pop(kid_id, None)
        return removed

    def delete_kid(self, kid_id: str):
        d = self.kids_dir / kid_id
        if d.exists():
            shutil.rmtree(d)
        self._cache.pop(kid_id, None)

    # ── Recognition ────────────────────────────────────────────────────────────

    def _load_embeddings(self, kid_id: str) -> list:
        if kid_id in self._cache:
            return self._cache[kid_id]
        emb_d = self.kids_dir / kid_id / "embeddings"
        if not emb_d.exists():
            return []
        result = [np.load(str(f)) for f in emb_d.glob("*.npy")]
        self._cache[kid_id] = result
        return result

    def analyze_photo(self, image_path: str, kid_ids: list[str], threshold: float = 0.35) -> dict:
        """Check photo against all specified kids. Returns overall match + per-kid breakdown."""
        try:
            faces = _get_model().get(self._read(image_path))
        except Exception as e:
            return {"matched": False, "faces_detected": 0, "matches": [], "error": str(e)}

        if not faces:
            return {"matched": False, "faces_detected": 0, "matches": []}

        face_embeddings = [f.normed_embedding for f in faces]
        kid_results = []
        for kid_id in kid_ids:
            stored = self._load_embeddings(kid_id)
            if not stored:
                continue
            # normed_embedding is unit-length, so cosine similarity = dot product
            best = max(float(np.dot(fe, se)) for fe in face_embeddings for se in stored)
            kid_results.append({
                "kid_id": kid_id,
                "confidence": round(best, 4),
                "matched": best >= threshold,
            })

        return {
            "matched": any(r["matched"] for r in kid_results),
            "faces_detected": len(faces),
            "matches": kid_results,
            "threshold": threshold,
        }

    def get_enrolled_count(self, kid_id: str) -> int:
        d = self.kids_dir / kid_id / "embeddings"
        return len(list(d.glob("*.npy"))) if d.exists() else 0
