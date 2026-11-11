# Reproducible SMaLL-100 ONNX export + int8 quantisation (GLIM-100), for publishing Glimpse's own
# copy of the model files on its model mirror (the manifest currently pins a community export of
# the same pipeline, see docs/decisions/GLIM-100-small100.md).
#
#   uv venv .venv && uv pip install --python .venv/bin/python \
#       --index-url https://download.pytorch.org/whl/cpu torch==2.5.1
#   uv pip install --python .venv/bin/python transformers==4.46.3 "optimum[onnxruntime]==1.23.3" onnx
#   .venv/bin/python packages/providers/scripts/small100-export.py <out dir>
#
# Writes <out>/encoder_model_quantized.onnx and <out>/decoder_model_merged_quantized.onnx (the
# file names the provider loads) and prints their SHA-256 and sizes for app/models/manifest.json.
# tokenizer.json is M2M-100's (Xenova/m2m100_418M), byte-identical vocabulary; not produced here.
import hashlib
import os
import sys

from huggingface_hub import snapshot_download
from onnxruntime.quantization import QuantType, quantize_dynamic
from optimum.exporters.onnx import main_export

REVISION = "8ab680e26a596d2e3d2d2d17ae0f68df1037328c"  # alirezamsh/small100, MIT

out = os.path.abspath(sys.argv[1])
fp32 = os.path.join(out, "fp32")
src = snapshot_download(
    "alirezamsh/small100",
    revision=REVISION,
    allow_patterns=["config.json", "model.safetensors", "sentencepiece.bpe.model", "vocab.json", "special_tokens_map.json", "tokenizer_config.json"],
)
# Encoder + merged decoder (one graph with and without the KV cache, `use_cache_branch`).
main_export(src, output=fp32, task="text2text-generation-with-past", opset=17, device="cpu", library_name="transformers", do_validation=False)

for name in ["encoder_model", "decoder_model_merged"]:
    target = os.path.join(out, f"{name}_quantized.onnx")
    # Dynamic int8, per channel, reduced range (activations quantised at run time). On 120 FLORES-101 sentences
    # this scored 43.4 chrF++ against 44.0 for the pinned community export; 4-bit (MatMulNBits +
    # 4-bit embeddings) scored 35.2 and was slower on AVX2, so it isn't used.
    quantize_dynamic(
        os.path.join(fp32, f"{name}.onnx"),
        target,
        weight_type=QuantType.QInt8,
        per_channel=True,
        # 7-bit weights: no u8s8 saturation on x86 without VNNI (onnxruntime quantisation docs).
        reduce_range=True,
        extra_options={"EnableSubgraph": True, "MatMulConstBOnly": True},
    )
    digest = hashlib.sha256(open(target, "rb").read()).hexdigest()
    print(f"{os.path.basename(target)}  {os.path.getsize(target)}  {digest}")
