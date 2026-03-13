"""
Face recognition test server.
Run: .venv/bin/python test_server.py
Then open: http://localhost:8001
"""

import pickle
import uuid
import io
import base64
import numpy as np
from pathlib import Path
from contextlib import asynccontextmanager

import cv2
import uvicorn
from fastapi import FastAPI, UploadFile, HTTPException
from fastapi.responses import HTMLResponse

ENROLL_FILE = Path("./data/test_embeddings.pkl")
THRESHOLD_DEFAULT = 0.35

app_state = {}


def load_model():
    from insightface.app import FaceAnalysis
    print("Loading face model (first run downloads ~200MB)...")
    fa = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
    fa.prepare(ctx_id=0, det_size=(640, 640))
    print("Model ready.")
    return fa


def load_enrolled() -> list:
    if ENROLL_FILE.exists():
        with open(ENROLL_FILE, "rb") as f:
            return pickle.load(f)
    return []


def save_enrolled(embeddings: list):
    ENROLL_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(ENROLL_FILE, "wb") as f:
        pickle.dump(embeddings, f)


def cosine_similarity(a, b) -> float:
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    return float(np.dot(a, b) / denom) if denom else 0.0


def decode_image(data: bytes) -> np.ndarray:
    arr = np.frombuffer(data, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image")
    return img


def img_to_b64(img: np.ndarray) -> str:
    _, buf = cv2.imencode(".jpg", img)
    return base64.b64encode(buf.tobytes()).decode()


@asynccontextmanager
async def lifespan(app: FastAPI):
    app_state["model"] = load_model()
    yield


app = FastAPI(lifespan=lifespan)


# ── API endpoints ──────────────────────────────────────────────────────────────

@app.post("/api/enroll")
async def enroll(file: UploadFile):
    data = await file.read()
    img = decode_image(data)

    fa = app_state["model"]
    faces = fa.get(img)
    if not faces:
        raise HTTPException(status_code=422, detail="No face detected. Try a clearer, well-lit photo.")

    # Crop the largest face for preview
    face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    x1, y1, x2, y2 = [max(0, int(v)) for v in face.bbox]
    crop = img[y1:y2, x1:x2]
    crop_b64 = img_to_b64(crop)

    stored = load_enrolled()
    stored.append(face.normed_embedding)
    save_enrolled(stored)

    return {
        "enrolled_total": len(stored),
        "faces_in_photo": len(faces),
        "face_crop": crop_b64,
    }


@app.post("/api/test")
async def test_photo(file: UploadFile, threshold: float = THRESHOLD_DEFAULT):
    stored = load_enrolled()
    if not stored:
        raise HTTPException(status_code=400, detail="No enrolled photos yet. Enroll your kid's face first.")

    data = await file.read()
    img = decode_image(data)

    fa = app_state["model"]
    faces = fa.get(img)

    if not faces:
        return {"matched": False, "faces_detected": 0, "results": [], "enrolled_count": len(stored)}

    results = []
    for i, face in enumerate(faces):
        best_sim = max(cosine_similarity(face.normed_embedding, se) for se in stored)
        matched = best_sim >= threshold

        # Crop face for display
        x1, y1, x2, y2 = [max(0, int(v)) for v in face.bbox]
        crop = img[y1:y2, x1:x2]
        crop_b64 = img_to_b64(crop)

        results.append({
            "face_index": i,
            "similarity": round(best_sim, 4),
            "matched": matched,
            "face_crop": crop_b64,
        })

    any_match = any(r["matched"] for r in results)
    return {
        "matched": any_match,
        "faces_detected": len(faces),
        "enrolled_count": len(stored),
        "threshold": threshold,
        "results": results,
    }


@app.get("/api/enrolled")
async def get_enrolled():
    stored = load_enrolled()
    return {"count": len(stored)}


@app.delete("/api/enrolled")
async def clear_enrolled():
    if ENROLL_FILE.exists():
        ENROLL_FILE.unlink()
    return {"count": 0}


@app.delete("/api/enrolled/{index}")
async def remove_one(index: int):
    stored = load_enrolled()
    if index < 0 or index >= len(stored):
        raise HTTPException(status_code=404, detail="Index out of range")
    stored.pop(index)
    save_enrolled(stored)
    return {"count": len(stored)}


# ── Frontend ───────────────────────────────────────────────────────────────────

HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Parent Tool — Face Recognition Test</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen">

  <nav class="bg-white border-b border-gray-200">
    <div class="max-w-5xl mx-auto px-6 py-4 flex items-center gap-3">
      <span class="text-2xl">&#128118;</span>
      <span class="text-xl font-bold text-gray-900">Parent Tool</span>
      <span class="text-sm text-gray-400 ml-2">Face Recognition Tester</span>
    </div>
  </nav>

  <main class="max-w-5xl mx-auto px-6 py-8">

    <!-- Toast -->
    <div id="toast" class="hidden fixed top-6 right-6 px-4 py-3 rounded-lg text-sm font-medium shadow-lg z-50"></div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">

      <!-- LEFT: Enroll -->
      <div class="space-y-4">
        <div class="bg-white rounded-xl border border-gray-200 p-6">
          <div class="flex items-center justify-between mb-1">
            <h2 class="font-semibold text-gray-900">1. Enroll Your Kid</h2>
            <span class="text-sm text-gray-400">
              <span id="enrolled-count">0</span> photo(s) enrolled
            </span>
          </div>
          <p class="text-sm text-gray-400 mb-4">Upload multiple clear face photos. More = better accuracy.</p>

          <div id="enroll-drop" class="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors">
            <div class="text-3xl mb-2">📷</div>
            <p class="text-sm text-gray-600 font-medium">Drop photos or click to upload</p>
            <input type="file" id="enroll-input" accept="image/*" multiple class="hidden" />
          </div>

          <div id="enrolled-faces" class="mt-4 grid grid-cols-4 gap-2"></div>

          <button onclick="clearAll()" class="mt-4 w-full py-2 text-sm text-red-500 bg-red-50 rounded-lg hover:bg-red-100 transition-colors">
            Clear All Enrollments
          </button>
        </div>
      </div>

      <!-- RIGHT: Test -->
      <div class="space-y-4">
        <div class="bg-white rounded-xl border border-gray-200 p-6">
          <h2 class="font-semibold text-gray-900 mb-1">2. Test a Photo</h2>
          <p class="text-sm text-gray-400 mb-3">Upload a photo and see if your kid is recognized.</p>

          <div class="flex items-center gap-3 mb-4">
            <label class="text-sm text-gray-600 whitespace-nowrap">Threshold:</label>
            <input type="range" id="threshold" min="20" max="70" value="35" step="1"
                   class="flex-1 accent-blue-600"
                   oninput="document.getElementById('threshold-val').textContent = this.value + '%'" />
            <span id="threshold-val" class="text-sm font-semibold text-blue-600 w-10 text-right">35%</span>
          </div>

          <div id="test-drop" class="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors">
            <div class="text-3xl mb-2">🔍</div>
            <p class="text-sm text-gray-600 font-medium">Drop a photo to test</p>
            <input type="file" id="test-input" accept="image/*" class="hidden" />
          </div>

          <!-- Results -->
          <div id="result-box" class="hidden mt-4">
            <div id="result-banner" class="rounded-xl p-4 text-center mb-4">
              <p id="result-headline" class="text-lg font-bold"></p>
              <p id="result-sub" class="text-sm mt-1 opacity-80"></p>
            </div>
            <div id="result-faces" class="grid grid-cols-3 gap-2"></div>
          </div>
        </div>
      </div>
    </div>

  </main>

  <script>
    function showToast(msg, type = 'success') {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.className = `fixed top-6 right-6 px-4 py-3 rounded-lg text-sm font-medium shadow-lg z-50 ${
        type === 'success' ? 'bg-green-600 text-white' : 'bg-red-500 text-white'
      }`;
      el.classList.remove('hidden');
      setTimeout(() => el.classList.add('hidden'), 3000);
    }

    // -- Enroll --
    const enrollDrop = document.getElementById('enroll-drop');
    const enrollInput = document.getElementById('enroll-input');
    enrollDrop.addEventListener('click', () => enrollInput.click());
    enrollDrop.addEventListener('dragover', e => { e.preventDefault(); enrollDrop.classList.add('border-blue-400'); });
    enrollDrop.addEventListener('dragleave', () => enrollDrop.classList.remove('border-blue-400'));
    enrollDrop.addEventListener('drop', e => { e.preventDefault(); enrollDrop.classList.remove('border-blue-400'); enrollFiles([...e.dataTransfer.files]); });
    enrollInput.addEventListener('change', () => { enrollFiles([...enrollInput.files]); enrollInput.value=''; });

    let enrolledCount = 0;

    async function enrollFiles(files) {
      for (const file of files) {
        const form = new FormData();
        form.append('file', file);
        try {
          const r = await fetch('/api/enroll', { method: 'POST', body: form });
          const d = await r.json();
          if (!r.ok) { showToast(d.detail || 'Failed', 'error'); continue; }
          enrolledCount = d.enrolled_total;
          document.getElementById('enrolled-count').textContent = enrolledCount;
          addEnrolledThumb(d.face_crop, enrolledCount - 1);
          showToast(`Enrolled! (${d.faces_in_photo} face${d.faces_in_photo > 1 ? 's' : ''} detected)`);
        } catch(e) { showToast('Upload failed', 'error'); }
      }
    }

    function addEnrolledThumb(b64, index) {
      const div = document.createElement('div');
      div.className = 'relative group';
      div.innerHTML = `
        <img src="data:image/jpeg;base64,${b64}" class="w-full aspect-square object-cover rounded-lg border border-green-200" />
        <div class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 rounded-lg flex items-center justify-center transition-opacity">
          <button onclick="removeOne(${index}, this.closest('.relative'))" class="text-white text-xs bg-red-500 px-2 py-1 rounded">Remove</button>
        </div>`;
      document.getElementById('enrolled-faces').appendChild(div);
    }

    async function removeOne(index, el) {
      const r = await fetch('/api/enrolled/' + index, { method: 'DELETE' });
      const d = await r.json();
      enrolledCount = d.count;
      document.getElementById('enrolled-count').textContent = enrolledCount;
      el.remove();
      showToast('Removed');
    }

    async function clearAll() {
      if (!confirm('Clear all enrolled photos?')) return;
      await fetch('/api/enrolled', { method: 'DELETE' });
      enrolledCount = 0;
      document.getElementById('enrolled-count').textContent = 0;
      document.getElementById('enrolled-faces').innerHTML = '';
      showToast('Cleared');
    }

    // -- Test --
    const testDrop = document.getElementById('test-drop');
    const testInput = document.getElementById('test-input');
    testDrop.addEventListener('click', () => testInput.click());
    testDrop.addEventListener('dragover', e => { e.preventDefault(); testDrop.classList.add('border-blue-400'); });
    testDrop.addEventListener('dragleave', () => testDrop.classList.remove('border-blue-400'));
    testDrop.addEventListener('drop', e => { e.preventDefault(); testDrop.classList.remove('border-blue-400'); testFile(e.dataTransfer.files[0]); });
    testInput.addEventListener('change', () => { testFile(testInput.files[0]); testInput.value=''; });

    async function testFile(file) {
      if (!file) return;
      const threshold = parseInt(document.getElementById('threshold').value) / 100;
      const form = new FormData();
      form.append('file', file);

      testDrop.innerHTML = '<div class="text-3xl mb-2 animate-pulse">⏳</div><p class="text-sm text-gray-400">Analyzing...</p>';

      try {
        const r = await fetch('/api/test?threshold=' + threshold, { method: 'POST', body: form });
        const d = await r.json();

        // Reset drop zone
        testDrop.innerHTML = '<div class="text-3xl mb-2">🔍</div><p class="text-sm text-gray-600 font-medium">Drop another photo to test</p>';

        if (!r.ok) { showToast(d.detail || 'Failed', 'error'); return; }

        showResult(d);
      } catch(e) {
        testDrop.innerHTML = '<div class="text-3xl mb-2">🔍</div><p class="text-sm text-gray-600 font-medium">Drop a photo to test</p>';
        showToast('Test failed — is the server running?', 'error');
      }
    }

    function showResult(d) {
      const box = document.getElementById('result-box');
      const banner = document.getElementById('result-banner');
      const headline = document.getElementById('result-headline');
      const sub = document.getElementById('result-sub');
      const facesEl = document.getElementById('result-faces');

      box.classList.remove('hidden');

      if (d.faces_detected === 0) {
        banner.className = 'rounded-xl p-4 text-center mb-4 bg-gray-100';
        headline.textContent = 'No faces detected';
        sub.textContent = 'Try a different photo';
        facesEl.innerHTML = '';
        return;
      }

      if (d.matched) {
        banner.className = 'rounded-xl p-4 text-center mb-4 bg-green-100';
        headline.textContent = '✓ Your kid is in this photo!';
        headline.className = 'text-lg font-bold text-green-800';
        sub.className = 'text-sm mt-1 opacity-80 text-green-700';
        sub.textContent = `${d.faces_detected} face(s) scanned — threshold ${(d.threshold * 100).toFixed(0)}%`;
      } else {
        banner.className = 'rounded-xl p-4 text-center mb-4 bg-gray-100';
        headline.textContent = 'Kid not found';
        headline.className = 'text-lg font-bold text-gray-600';
        sub.className = 'text-sm mt-1 opacity-80 text-gray-500';
        sub.textContent = `${d.faces_detected} face(s) scanned — threshold ${(d.threshold * 100).toFixed(0)}%`;
      }

      facesEl.innerHTML = d.results.map(f => `
        <div class="rounded-lg border ${f.matched ? 'border-green-400 bg-green-50' : 'border-gray-200'} p-2 text-center">
          <img src="data:image/jpeg;base64,${f.face_crop}" class="w-full aspect-square object-cover rounded mb-1" />
          <p class="text-xs font-semibold ${f.matched ? 'text-green-700' : 'text-gray-500'}">
            ${(f.similarity * 100).toFixed(1)}%
          </p>
          <p class="text-xs ${f.matched ? 'text-green-600' : 'text-gray-400'}">
            ${f.matched ? 'Match ✓' : 'No match'}
          </p>
        </div>`).join('');
    }

    // Load initial count
    fetch('/api/enrolled').then(r => r.json()).then(d => {
      enrolledCount = d.count;
      document.getElementById('enrolled-count').textContent = d.count;
    });
  </script>
</body>
</html>"""


@app.get("/", response_class=HTMLResponse)
async def index():
    return HTML


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8001, log_level="info")
