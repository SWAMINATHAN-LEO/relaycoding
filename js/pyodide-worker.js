/**
 * js/pyodide-worker.js - Sandboxed In-Browser Python Execution Worker
 */
importScripts("https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js");

let pyodide = null;
let isReady = false;

async function init() {
  pyodide = await loadPyodide({
    stdout: (text) => postMessage({ type: 'stdout', data: text }),
    stderr: (text) => postMessage({ type: 'stderr', data: text })
  });
  isReady = true;
  postMessage({ type: 'ready' });
}
init();

self.onmessage = async (e) => {
  const { code, stdin, runId } = e.data;
  if (!isReady) {
    postMessage({ type: 'error', runId, error: 'Pyodide execution engine initializing...' });
    return;
  }

  try {
    // Intercept stdin using StringIO
    await pyodide.runPythonAsync(`
import sys, io
sys.stdin = io.StringIO(${JSON.stringify(stdin || '')})
    `);

    const start = performance.now();
    await pyodide.runPythonAsync(code);
    const duration = Math.round(performance.now() - start);

    postMessage({ type: 'finished', runId, duration });
  } catch (err) {
    postMessage({ type: 'error', runId, error: err.message });
  }
};
