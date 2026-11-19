const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const logger = require('../core/logger').createServiceLogger('VOSK-WORKER');

class VoskWorkerService extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.pythonPath = this._resolvePythonPath();
    this.scriptPath = path.join(__dirname, '../../scripts/vosk_worker.py');
    this.isReady = false;
    this.closing = false;
    this.completedText = '';
  }

  _resolvePythonPath() {
    if (process.env.PYTHON_PATH && fs.existsSync(process.env.PYTHON_PATH)) {
      return process.env.PYTHON_PATH;
    }
    // Check local virtual environments first if any
    const candidates = [
      path.join(process.cwd(), '.venv', 'Scripts', 'python.exe'),
      path.join(process.cwd(), '.venv-whisper', 'Scripts', 'python.exe'),
      'python'
    ];
    for (const c of candidates) {
      if (c === 'python') return 'python';
      if (fs.existsSync(c)) return c;
    }
    return 'python';
  }

  isAvailable() {
    if (this._available !== undefined) {
      return this._available;
    }
    try {
      const probe = spawnSync(this.pythonPath, ['-c', 'import vosk; print("ok")'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000
      });
      this._available = probe.status === 0 && (probe.stdout || '').includes('ok');
      return this._available;
    } catch (_) {
      this._available = false;
      return false;
    }
  }

  start() {
    if (this.process && !this.process.killed) {
      return;
    }

    this.closing = false;
    this.isReady = false;

    try {
      this.process = spawn(this.pythonPath, ['-u', this.scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });

      const lines = readline.createInterface({ input: this.process.stdout });
      lines.on('line', (line) => this._handleLine(line));

      this.process.stderr.on('data', (chunk) => {
        const msg = chunk.toString().trim();
        if (msg) {
          logger.debug('Vosk worker stderr', { msg: msg.substring(0, 500) });
        }
      });

      this.process.on('error', (err) => {
        logger.error('Vosk worker error', { error: err.message });
        this.emit('error', err);
      });

      this.process.on('exit', (code, signal) => {
        logger.info('Vosk worker exited', { code, signal });
        this.process = null;
        this.isReady = false;
        if (!this.closing) {
          this.emit('status', 'Vosk worker exited');
        }
      });

      logger.info('Vosk worker process spawned', { python: this.pythonPath });
    } catch (err) {
      logger.error('Failed to spawn Vosk worker', { error: err.message });
      this.emit('error', err);
    }
  }

  sendChunk(buffer) {
    if (!this.process || !this.process.stdin.writable) {
      this.start();
    }
    try {
      const base64 = buffer.toString('base64');
      const payload = JSON.stringify({ action: 'chunk', data: base64 }) + '\n';
      this.process.stdin.write(payload);
    } catch (err) {
      logger.error('Error writing audio chunk to Vosk worker', { error: err.message });
    }
  }

  syncText(text) {
    this.completedText = (text || '').trim();
    this.currentGen = (this.currentGen || 0) + 1;
    this.ignoringChunksUntilGen = this.currentGen;
    if (this.process && this.process.stdin.writable) {
      try {
        this.process.stdin.write(JSON.stringify({ action: 'reset', gen: this.currentGen }) + '\n');
      } catch (_) {}
    }
  }

  reset() {
    this.completedText = '';
    this.currentGen = (this.currentGen || 0) + 1;
    this.ignoringChunksUntilGen = this.currentGen;
    if (this.process && this.process.stdin.writable) {
      try {
        this.process.stdin.write(JSON.stringify({ action: 'reset', gen: this.currentGen }) + '\n');
      } catch (_) {}
    }
  }

  finish() {
    // Only send finish if there is text or not ignoring
    if (this.process && this.process.stdin.writable) {
      try {
        this.process.stdin.write(JSON.stringify({ action: 'finish' }) + '\n');
      } catch (_) {}
    }
  }

  stop() {
    this.closing = true;
    if (this.process) {
      try {
        if (this.process.stdin.writable) {
          this.process.stdin.write(JSON.stringify({ action: 'shutdown' }) + '\n');
        }
      } catch (_) {}
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill();
        }
      }, 500);
    }
  }

  _handleLine(line) {
    line = line.trim();
    if (!line) return;
    try {
      const data = JSON.parse(line);
      const event = data.event;

      if (event === 'ready') {
        this.isReady = true;
        logger.info('Vosk worker is ready', data);
        this.emit('ready', data);
      } else if (event === 'reset_done' || event === 'clear_done') {
        if (data.gen && data.gen >= (this.ignoringChunksUntilGen || 0)) {
          this.ignoringChunksUntilGen = 0;
        }
      } else if (event === 'partial') {
        if (this.ignoringChunksUntilGen > 0) {
          return; // Discard pre-reset audio remnants
        }
        const partial = (data.text || '').trim();
        const fullText = this.completedText
          ? (partial ? `${this.completedText} ${partial}` : this.completedText)
          : partial;
        if (fullText) {
          this.emit('partial', fullText);
        }
      } else if (event === 'final') {
        if (this.ignoringChunksUntilGen > 0) {
          return; // Discard pre-reset audio remnants
        }
        const finalChunk = (data.text || '').trim();
        if (finalChunk) {
          this.completedText = this.completedText
            ? `${this.completedText} ${finalChunk}`
            : finalChunk;
          this.emit('partial', this.completedText);
          this.emit('final', this.completedText);
        }
      } else if (event === 'error') {
        logger.error('Vosk worker reported error', data);
        this.emit('error', new Error(data.message || data.error || 'Vosk error'));
      }
    } catch (e) {
      logger.warn('Failed to parse Vosk worker line', { line, error: e.message });
    }
  }
}

module.exports = VoskWorkerService;
