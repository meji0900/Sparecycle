# Portions derived from https://github.com/idlexnetwork/idlex (MIT License, Copyright (c) 2026 Idlex) - see NOTICE.
"""Sparecycle image worker: Stable Diffusion 1.5 on the local NVIDIA GPU.

Reads one JSON request per line on stdin, writes one JSON reply per line on stdout:
  in:  {"id": "...", "prompt": "...", "negative": "...", "width": 512, "height": 512, "steps": 20, "guidance": 7, "seed": 42}
  out: {"id": "...", "png": "<base64>", "gpu_ms": 1234.5, "nsfw": false}   or   {"id": "...", "error": "..."}
The first line written is {"ready": true, "gpu": "<name>"} (or {"ready": false, "error": "..."}).

The seed and settings come from the scheduler, so the second node renders a near-identical image.
Model: stable-diffusion-v1-5 (CreativeML OpenRAIL-M), fp16, with its safety checker ON. A flagged image is
reported as nsfw=true; the scheduler then rejects the job (unpaid, no output kept).
"""
import base64
import io
import json
import os
import sys
import time

import torch
from diffusers import StableDiffusionPipeline

MODEL = os.environ.get("SPARECYCLE_SD15_MODEL", "stable-diffusion-v1-5/stable-diffusion-v1-5")
# Every node must load byte-identical weights, or two honest nodes can disagree. Pin the Hugging Face commit.
REVISION = os.environ.get("SPARECYCLE_SD15_REVISION", "451f4fe16113bff5a5d2269ed5ad43b0592e9a14")


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def reply(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def main() -> None:
    if not torch.cuda.is_available():
        reply({"ready": False, "error": "CUDA GPU not available"})
        return
    log(f"loading {MODEL} on {torch.cuda.get_device_name(0)}")
    pipe = StableDiffusionPipeline.from_pretrained(MODEL, revision=REVISION, torch_dtype=torch.float16, variant="fp16")
    pipe = pipe.to("cuda")
    pipe.set_progress_bar_config(disable=True)
    torch.backends.cudnn.benchmark = False  # deterministic kernel choice helps two nodes agree
    reply({"ready": True, "gpu": torch.cuda.get_device_name(0)})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = {}
        try:
            req = json.loads(line)
            gen = torch.Generator(device="cuda").manual_seed(int(req["seed"]))
            torch.cuda.synchronize()
            t0 = time.perf_counter()
            out = pipe(
                prompt=req["prompt"],
                negative_prompt=req.get("negative") or None,
                width=int(req["width"]),
                height=int(req["height"]),
                num_inference_steps=int(req["steps"]),
                guidance_scale=float(req.get("guidance", 7)),
                generator=gen,
            )
            torch.cuda.synchronize()
            gpu_ms = (time.perf_counter() - t0) * 1000
            buf = io.BytesIO()
            out.images[0].save(buf, format="PNG")
            nsfw = bool(out.nsfw_content_detected and out.nsfw_content_detected[0])
            reply({"id": req["id"], "png": base64.b64encode(buf.getvalue()).decode(), "gpu_ms": gpu_ms, "nsfw": nsfw})
        except Exception as e:  # noqa: BLE001 - report every failure to the node client
            reply({"id": req.get("id"), "error": str(e)[:500]})


if __name__ == "__main__":
    main()
