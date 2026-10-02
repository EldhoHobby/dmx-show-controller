// Runs the song analysis off the main thread so the UI stays responsive.
import { analyzeAudio } from '/shared/analysis/analyze.js';

self.onmessage = (e) => {
  const { channels, sampleRate } = e.data;
  try {
    const result = analyzeAudio(
      { channels, sampleRate },
      { onProgress: (p, label) => self.postMessage({ type: 'progress', p, label }) },
    );
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
