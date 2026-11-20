(() => {
  const cfg = window.RECORDER_CONFIG || {};
  const isDriveMode = Boolean(cfg.GOOGLE_APPS_SCRIPT_URL && cfg.GOOGLE_APPS_SCRIPT_URL.trim());

  const $ = (id) => document.getElementById(id);
  const modeBadge = $("modeBadge");
  const setupCard = $("setupCard");
  const recordCard = $("recordCard");
  const doneCard = $("doneCard");

  const speakerInput = $("speakerId");
  const regionSelect = $("region");
  const ageSelect = $("ageGroup");
  const pinField = $("pinField");
  const pinInput = $("pinInput");
  const sessionSelect = $("sessionCount");
  const consentCheck = $("consentCheck");
  const startBtn = $("startBtn");
  const setupError = $("setupError");

  const progressText = $("progressText");
  const progressFill = $("progressFill");
  const categoryBadge = $("categoryBadge");
  const promptText = $("promptText");
  const levelBar = $("levelBar");
  const timerText = $("timerText");
  const recordBtn = $("recordBtn");
  const reviewSection = $("reviewSection");
  const audioPlayback = $("audioPlayback");
  const retryBtn = $("retryBtn");
  const uploadBtn = $("uploadBtn");
  const skipBtn = $("skipBtn");
  const changeUserBtn = $("changeUserBtn");
  const statusMsg = $("statusMsg");
  const doneSummary = $("doneSummary");
  const moreBtn = $("moreBtn");

  modeBadge.textContent = isDriveMode ? "Modo Google Drive" : "Modo Local (PC)";
  if (!isDriveMode && !cfg.REQUIRE_PIN_IN_LOCAL_MODE) {
    pinField.classList.add("hidden");
  }

  let allPrompts = [];
  let sessionPrompts = [];
  let currentIdx = 0;
  let uploadedCount = 0;
  let userState = {};

  let mediaStream = null;
  let mediaRecorder = null;
  let audioChunks = [];
  let analyser = null;
  let audioCtx = null;
  let rafId = null;
  let timerInterval = null;
  let recordStartMs = 0;
  let currentWavBlob = null;
  let currentDurationSec = 0;

  function validateSetup() {
    const hasSpeaker = speakerInput.value.trim().length >= 2;
    const hasPin = !isDriveMode && !cfg.REQUIRE_PIN_IN_LOCAL_MODE ? true : pinInput.value.trim().length >= 2;
    startBtn.disabled = !(hasSpeaker && hasPin && consentCheck.checked && allPrompts.length > 0);
  }

  [speakerInput, pinInput, consentCheck].forEach((el) => {
    el.addEventListener("input", validateSetup);
    el.addEventListener("change", validateSetup);
  });

  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function seededShuffle(items, seed) {
    const arr = items.slice();
    let s = seed || 1;
    for (let i = arr.length - 1; i > 0; i--) {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0;
      const j = s % (i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function getDoneIds(speakerId) {
    try {
      return new Set(JSON.parse(localStorage.getItem(`done_${speakerId}`) || "[]"));
    } catch {
      return new Set();
    }
  }

  function markDoneId(speakerId, promptId) {
    const done = getDoneIds(speakerId);
    done.add(promptId);
    localStorage.setItem(`done_${speakerId}`, JSON.stringify([...done]));
  }

  function buildSessionQueue(speakerId, count) {
    const done = getDoneIds(speakerId);
    const remaining = allPrompts.filter((p) => !done.has(p.id));
    const pool = remaining.length > 0 ? remaining : allPrompts;

    const voiceRefs = pool.filter((p) => p.category === "voice_ref");
    const others = seededShuffle(
      pool.filter((p) => p.category !== "voice_ref"),
      hashString(speakerId)
    );
    const ordered = [...voiceRefs.slice(0, 1), ...others];
    return ordered.slice(0, Math.min(count, ordered.length));
  }

  function showPrompt() {
    if (currentIdx >= sessionPrompts.length) {
      recordCard.classList.add("hidden");
      doneCard.classList.remove("hidden");
      doneSummary.textContent = `Subiste ${uploadedCount} grabaciones como "${userState.speaker_id}". ¡Tu voz ayudará muchísimo!`;
      return;
    }

    const p = sessionPrompts[currentIdx];
    progressText.textContent = `Frase ${currentIdx + 1} de ${sessionPrompts.length}`;
    progressFill.style.width = `${Math.round((currentIdx / sessionPrompts.length) * 100)}%`;
    categoryBadge.textContent = p.category;
    promptText.textContent = p.text;
    timerText.textContent = "00:00";
    levelBar.style.width = "0%";
    reviewSection.classList.add("hidden");
    statusMsg.textContent = "";
    currentWavBlob = null;
    recordBtn.disabled = false;
    recordBtn.textContent = "🎙️ Grabar";
    recordBtn.classList.remove("recording");
  }

  function encodeWav16kMono(float32Samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + float32Samples.length * 2);
    const view = new DataView(buffer);
    const writeStr = (offset, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    };

    writeStr(0, "RIFF");
    view.setUint32(4, 36 + float32Samples.length * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // Mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, float32Samples.length * 2, true);

    let offset = 44;
    for (let i = 0; i < float32Samples.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  async function blobToWav16k(blob) {
    const arrayBuf = await blob.arrayBuffer();
    const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await decodeCtx.decodeAudioData(arrayBuf);
    const targetRate = 16000;
    const frameCount = Math.max(1, Math.ceil(decoded.duration * targetRate));
    const offline = new OfflineAudioContext(1, frameCount, targetRate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start(0);
    const rendered = await offline.startRendering();
    await decodeCtx.close();

    const pcm = rendered.getChannelData(0);
    currentDurationSec = Number(rendered.duration.toFixed(3));
    return encodeWav16kMono(pcm, targetRate);
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const res = String(reader.result || "");
        resolve(res.split(",")[1] || "");
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function updateLevelMeter() {
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    levelBar.style.width = `${Math.min(100, Math.round(rms * 320))}%`;
    rafId = requestAnimationFrame(updateLevelMeter);
  }

  function formatTimer(sec) {
    const m = String(Math.floor(sec / 60)).padStart(2, "0");
    const s = String(Math.floor(sec % 60)).padStart(2, "0");
    return `${m}:${s}`;
  }

  async function startRecording() {
    statusMsg.textContent = "";
    reviewSection.classList.add("hidden");
    audioChunks = [];

    if (!mediaStream) {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
      });
    }

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(mediaStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    updateLevelMeter();

    mediaRecorder = new MediaRecorder(mediaStream);
    mediaRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) audioChunks.push(ev.data);
    };
    mediaRecorder.onstop = async () => {
      cancelAnimationFrame(rafId);
      clearInterval(timerInterval);
      levelBar.style.width = "0%";
      if (audioCtx) {
        await audioCtx.close();
        audioCtx = null;
      }

      statusMsg.textContent = "Procesando audio 16 kHz WAV...";
      try {
        const rawBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
        currentWavBlob = await blobToWav16k(rawBlob);
        audioPlayback.src = URL.createObjectURL(currentWavBlob);
        reviewSection.classList.remove("hidden");
        statusMsg.textContent = `Listo (${currentDurationSec.toFixed(1)}s). Escúchalo o guárdalo.`;
      } catch (err) {
        statusMsg.textContent = `Error procesando audio: ${err.message}`;
      }
    };

    mediaRecorder.start();
    recordStartMs = Date.now();
    timerInterval = setInterval(() => {
      timerText.textContent = formatTimer((Date.now() - recordStartMs) / 1000);
    }, 200);

    recordBtn.textContent = "⏹️ Parar grabación";
    recordBtn.classList.add("recording");
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
      recordBtn.textContent = "🎙️ Grabar de nuevo";
      recordBtn.classList.remove("recording");
    }
  }

  recordBtn.addEventListener("click", async () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      stopRecording();
    } else {
      try {
        await startRecording();
      } catch (err) {
        statusMsg.textContent = `No se pudo abrir el micrófono: ${err.message}`;
      }
    }
  });

  retryBtn.addEventListener("click", () => {
    reviewSection.classList.add("hidden");
    currentWavBlob = null;
    timerText.textContent = "00:00";
    statusMsg.textContent = "Listo para repetir.";
  });

  uploadBtn.addEventListener("click", async () => {
    if (!currentWavBlob) return;
    const p = sessionPrompts[currentIdx];
    uploadBtn.disabled = true;
    statusMsg.textContent = "Subiendo grabación...";

    try {
      const audio_b64 = await blobToBase64(currentWavBlob);
      const payload = {
        pin: userState.pin,
        speaker_id: userState.speaker_id,
        region: userState.region,
        age_group: userState.age_group,
        prompt_id: p.id,
        category: p.category,
        text: p.text,
        duration_sec: currentDurationSec,
        consent_version: "v1",
        audio_b64,
      };

      const endpoint = isDriveMode ? cfg.GOOGLE_APPS_SCRIPT_URL.trim() : "/upload";
      // Use text/plain for Apps Script to avoid CORS preflight failures
      const res = await fetch(endpoint, {
        method: "POST",
        redirect: "follow",
        headers: { "Content-Type": isDriveMode ? "text/plain;charset=utf-8" : "application/json" },
        body: JSON.stringify(payload),
      });
      const rawText = await res.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch {
        throw new Error(`Respuesta no-JSON (${res.status}) desde ${isDriveMode ? "Google Drive" : "servidor local"}. Recarga la página (Ctrl+Shift+R).`);
      }
      if (!data.ok) {
        throw new Error(data.error || "Error al subir");
      }

      markDoneId(userState.speaker_id, p.id);
      uploadedCount += 1;
      currentIdx += 1;
      showPrompt();
    } catch (err) {
      statusMsg.textContent = `Error al subir: ${err.message}`;
    } finally {
      uploadBtn.disabled = false;
    }
  });

  skipBtn.addEventListener("click", () => {
    currentIdx += 1;
    showPrompt();
  });

  changeUserBtn.addEventListener("click", () => {
    recordCard.classList.add("hidden");
    setupCard.classList.remove("hidden");
  });

  moreBtn.addEventListener("click", () => {
    doneCard.classList.add("hidden");
    sessionPrompts = buildSessionQueue(userState.speaker_id, Number(sessionSelect.value || 25));
    currentIdx = 0;
    recordCard.classList.remove("hidden");
    showPrompt();
  });

  startBtn.addEventListener("click", async () => {
    setupError.classList.add("hidden");
    const cleanId = speakerInput.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    const normalizedPin = pinInput.value.trim().toUpperCase();

    if (isDriveMode) {
      startBtn.disabled = true;
      startBtn.textContent = "Verificando PIN...";
      try {
        const res = await fetch(cfg.GOOGLE_APPS_SCRIPT_URL.trim(), {
          method: "POST",
          redirect: "follow",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ pin: normalizedPin }),
        });
        const data = JSON.parse(await res.text());
        if (data.error && data.error.toLowerCase().includes("pin")) {
          setupError.textContent = "PIN incorrecto. Verifica el PIN e intenta de nuevo.";
          setupError.classList.remove("hidden");
          return;
        }
      } catch (err) {
        setupError.textContent = `No se pudo verificar el PIN: ${err.message}`;
        setupError.classList.remove("hidden");
        return;
      } finally {
        startBtn.disabled = false;
        startBtn.textContent = "Comenzar a grabar";
      }
    }

    userState = {
      speaker_id: cleanId,
      region: regionSelect.value,
      age_group: ageSelect.value,
      pin: normalizedPin,
    };
    const count = Number(sessionSelect.value || cfg.DEFAULT_PROMPTS_PER_SESSION || 25);
    sessionPrompts = buildSessionQueue(cleanId, count);
    currentIdx = 0;
    uploadedCount = 0;

    setupCard.classList.add("hidden");
    recordCard.classList.remove("hidden");
    showPrompt();
  });

  fetch("prompts_pr_med.json")
    .then((r) => r.json())
    .then((d) => {
      allPrompts = d.prompts || [];
      validateSetup();
    })
    .catch((err) => {
      setupError.textContent = `Error cargando prompts_pr_med.json: ${err.message}`;
      setupError.classList.remove("hidden");
    });
})();
