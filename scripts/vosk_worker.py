import base64
import json
import os
import sys
import traceback
import vosk

# Disable verbose logging from Vosk/Kaldi to keep stdout clean
vosk.SetLogLevel(-1)

model = None
recognizer = None
sample_rate = 16000.0


def send(payload):
    try:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + '\n')
        sys.stdout.flush()
    except Exception:
        pass


def init_recognizer(model_path=None):
    global model, recognizer
    try:
        # Candidate locations: explicit override, env var, or local project model
        candidate_paths = []
        if model_path:
            candidate_paths.append(model_path)
        
        env_path = os.environ.get('VOSK_MODEL_PATH')
        if env_path:
            candidate_paths.append(env_path)

        project_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
        candidate_paths.append(os.path.join(project_dir, '.vosk-models', 'vosk-model-en-us-0.22-lgraph'))
        candidate_paths.append(os.path.join(project_dir, '.vosk-models', 'model'))

        loaded = False
        for p in candidate_paths:
            if p and os.path.exists(p):
                sys.stderr.write(f"Loading Vosk model from: {p}\n")
                sys.stderr.flush()
                model = vosk.Model(p)
                loaded = True
                break

        if not loaded:
            model = vosk.Model(lang="en-us")
        
        recognizer = vosk.KaldiRecognizer(model, sample_rate)
        recognizer.SetWords(True)
        return True
    except Exception as e:
        sys.stderr.write(f"Error initializing Vosk: {e}\n")
        sys.stderr.flush()
        return False


if __name__ == '__main__':
    model_override = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('VOSK_MODEL_PATH')
    if init_recognizer(model_override):
        send({'event': 'ready', 'provider': 'vosk', 'sample_rate': sample_rate})
    else:
        send({'event': 'error', 'message': 'Failed to initialize Vosk model'})
        sys.exit(1)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            action = req.get('action')

            if action == 'chunk':
                data_b64 = req.get('data')
                if data_b64:
                    raw_bytes = base64.b64decode(data_b64)
                    if recognizer.AcceptWaveform(raw_bytes):
                        res = json.loads(recognizer.Result())
                        final_text = res.get('text', '').strip()
                        if final_text:
                            send({'event': 'final', 'text': final_text})
                    else:
                        partial_res = json.loads(recognizer.PartialResult())
                        partial_text = partial_res.get('partial', '').strip()
                        send({'event': 'partial', 'text': partial_text})

            elif action == 'reset':
                recognizer.Reset()
                send({'event': 'reset_done', 'gen': req.get('gen', 0)})

            elif action == 'clear':
                recognizer.Reset()
                send({'event': 'clear_done', 'gen': req.get('gen', 0)})

            elif action == 'finish':
                res = json.loads(recognizer.FinalResult())
                final_text = res.get('text', '').strip()
                send({'event': 'final', 'text': final_text})
                recognizer.Reset()

            elif action == 'shutdown':
                send({'event': 'shutdown_done'})
                break

        except Exception as err:
            send({'event': 'error', 'error': str(err), 'traceback': traceback.format_exc()})
