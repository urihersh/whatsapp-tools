"""
Standalone face recognition test using insightface + onnxruntime.

Usage:
  # Enroll a photo of your kid:
  python test_face.py enroll path/to/kid_photo.jpg

  # Test recognition against another photo:
  python test_face.py test path/to/another_photo.jpg

  # List enrolled faces:
  python test_face.py list

  # Clear all enrollments:
  python test_face.py clear
"""

import sys
import os
import pickle
import numpy as np
from pathlib import Path

ENROLL_FILE = Path("./data/test_embeddings.pkl")

# ---------------------------------------------------------------------------

def get_app():
    import insightface
    from insightface.app import FaceAnalysis
    print("Loading face model (first run downloads ~200MB)...")
    app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=0, det_size=(640, 640))
    return app


def get_embeddings(app, image_path: str) -> list:
    import cv2
    img = cv2.imread(image_path)
    if img is None:
        raise ValueError(f"Could not read image: {image_path}")
    faces = app.get(img)
    return [f.normed_embedding for f in faces]


def cosine_similarity(a, b) -> float:
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def load_enrolled() -> list:
    if ENROLL_FILE.exists():
        with open(ENROLL_FILE, "rb") as f:
            return pickle.load(f)
    return []


def save_enrolled(embeddings: list):
    ENROLL_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(ENROLL_FILE, "wb") as f:
        pickle.dump(embeddings, f)


# ---------------------------------------------------------------------------

def cmd_enroll(image_path: str):
    app = get_app()
    embeddings = get_embeddings(app, image_path)
    if not embeddings:
        print("ERROR: No face detected in this photo. Try a clearer, well-lit shot.")
        return

    print(f"Detected {len(embeddings)} face(s) in photo.")
    if len(embeddings) > 1:
        print("  → Using the largest face (first detected).")

    stored = load_enrolled()
    stored.append(embeddings[0])
    save_enrolled(stored)
    print(f"Enrolled! Total enrolled embeddings: {len(stored)}")


def cmd_test(image_path: str, threshold: float = 0.35):
    stored = load_enrolled()
    if not stored:
        print("No enrolled photos yet. Run: python test_face.py enroll <photo>")
        return

    app = get_app()
    query_embeddings = get_embeddings(app, image_path)
    if not query_embeddings:
        print("No faces detected in test photo.")
        return

    print(f"\nTest photo: {image_path}")
    print(f"Faces in test photo: {len(query_embeddings)}")
    print(f"Enrolled embeddings: {len(stored)}")
    print(f"Threshold: {threshold}\n")

    any_match = False
    for i, qe in enumerate(query_embeddings):
        best_sim = max(cosine_similarity(qe, se) for se in stored)
        matched = best_sim >= threshold
        status = "MATCH ✓" if matched else "no match"
        print(f"  Face {i+1}: similarity={best_sim:.3f}  →  {status}")
        if matched:
            any_match = True

    print()
    if any_match:
        print("Result: YOUR KID IS IN THIS PHOTO")
    else:
        print("Result: kid not found in this photo")


def cmd_list():
    stored = load_enrolled()
    print(f"Enrolled embeddings: {len(stored)}")
    for i, e in enumerate(stored):
        print(f"  [{i}] norm={np.linalg.norm(e):.4f}")


def cmd_clear():
    if ENROLL_FILE.exists():
        ENROLL_FILE.unlink()
        print("Cleared all enrolled embeddings.")
    else:
        print("Nothing to clear.")


# ---------------------------------------------------------------------------

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "enroll":
        if len(sys.argv) < 3:
            print("Usage: python test_face.py enroll <photo_path>")
            sys.exit(1)
        cmd_enroll(sys.argv[2])

    elif cmd == "test":
        if len(sys.argv) < 3:
            print("Usage: python test_face.py test <photo_path> [threshold]")
            sys.exit(1)
        threshold = float(sys.argv[3]) if len(sys.argv) > 3 else 0.35
        cmd_test(sys.argv[2], threshold)

    elif cmd == "list":
        cmd_list()

    elif cmd == "clear":
        cmd_clear()

    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)
