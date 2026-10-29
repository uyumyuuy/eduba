---
license: apache-2.0
library_name: PaddleOCR
language:
- en
- zh
pipeline_tag: image-to-text
tags:
- OCR
- PaddlePaddle
- PaddleOCR
- layout_detection
---

# PicoDet-S_layout_3cls

## Introduction

A high-efficiency layout area localization model trained on a self-built dataset of Chinese and English papers, magazines, and research reports using PicoDet-S. It supports 3 types of layout areas: table, figure, and seal. 

| Model| mAP(0.5) (%) | 
|  --- | --- | 
|PicoDet-S_layout_3cls |  88.2 | 

**Note**: Paddleocr's self built layout area detection data set contains 1154 common document type images such as Chinese and English papers, magazines and research papers.

## Quick Start

### Installation

1. PaddlePaddle

Please refer to the following commands to install PaddlePaddle using pip:

```bash
# for CUDA11.8
python -m pip install paddlepaddle-gpu==3.0.0 -i https://www.paddlepaddle.org.cn/packages/stable/cu118/

# for CUDA12.6
python -m pip install paddlepaddle-gpu==3.0.0 -i https://www.paddlepaddle.org.cn/packages/stable/cu126/

# for CPU
python -m pip install paddlepaddle==3.0.0 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
```

For details about PaddlePaddle installation, please refer to the [PaddlePaddle official website](https://www.paddlepaddle.org.cn/en/install/quick).

2. PaddleOCR

Install the latest version of the PaddleOCR inference package from PyPI:

```bash
python -m pip install paddleocr
```

### Model Usage

You can quickly experience the functionality with a single command:

```bash
paddleocr layout_detection --model_name PicoDet-S_layout_3cls --threshold 0.6 -i https://cdn-uploads.huggingface.co/production/uploads/63d7b8ee07cd1aa3c49a2026/N5C68HPVAI-xQAWTxpbA6.jpeg 
```

You can also integrate the model inference of the LayoutDetection module into your project. Before running the following code, please download the sample image to your local machine.

```python
from paddleocr import LayoutDetection

model = LayoutDetection(model_name="PicoDet-S_layout_3cls")
output = model.predict("N5C68HPVAI-xQAWTxpbA6.jpeg", batch_size=1, layout_nms=True)
for res in output:
    res.print()
    res.save_to_img(save_path="./output/")
    res.save_to_json(save_path="./output/res.json")
```

After running, the obtained result is as follows:

```json
{'res': {'input_path': '/root/.paddlex/predict_input/N5C68HPVAI-xQAWTxpbA6.jpeg', 'page_index': None, 'boxes': [{'cls_id': 1, 'label': 'table', 'score': 0.9367532134056091, 'coordinate': [74.82668, 106.17916, 322.33493, 300.35388]}, {'cls_id': 1, 'label': 'table', 'score': 0.9143182039260864, 'coordinate': [437.6252, 105.94054, 664.5405, 315.0713]}]}}
```

The visualized image is as follows:

![image/jpeg](https://cdn-uploads.huggingface.co/production/uploads/63d7b8ee07cd1aa3c49a2026/Smz6s33SNQDwgGumNrLMu.jpeg)

For details about usage command and descriptions of parameters, please refer to the [Document](https://paddlepaddle.github.io/PaddleOCR/latest/en/version3.x/module_usage/layout_detection.html#iii-quick-integration).

### Pipeline Usage

The ability of a single model is limited. But the pipeline consists of several models can provide more capacity to resolve difficult problems in real-world scenarios.

#### PP-ChatOCRv4-doc

PP-ChatOCRv4-doc is a unique document and image intelligent analysis solution from PaddlePaddle, combining LLM, MLLM, and OCR technologies to address complex document information extraction challenges such as layout analysis, rare characters, multi-page PDFs, tables, and seal recognition. Integrated with ERNIE Bot, it fuses massive data and knowledge, achieving high accuracy and wide applicability. 

The Document Scene Information Extraction v4 pipeline includes modules for Layout Region Detection, Table Structure Recognition, Table Classification, Table Cell Localization, Text Detection, Text Recognition, Seal Text Detection, Text Image Rectification, and Document Image Orientation Classification.


You can quickly experience the PP-ChatOCRv4-doc pipeline with a single command.

```bash
paddleocr pp_chatocrv4_doc -i vehicle_certificate-1.png -k 驾驶室准乘人数 --qianfan_api_key your_api_key --layout_detection_model_name PicoDet-S_layout_3cls

```

If save_path is specified, the visualization results will be saved under `save_path`. 

The command-line method is for quick experience. For project integration, also only a few codes are needed as well:


```python
from paddleocr import PPChatOCRv4Doc

chat_bot_config = {
    "module_name": "chat_bot",
    "model_name": "ernie-3.5-8k",
    "base_url": "https://qianfan.baidubce.com/v2",
    "api_type": "openai",
    "api_key": "api_key",  # your api_key
}

retriever_config = {
    "module_name": "retriever",
    "model_name": "embedding-v1",
    "base_url": "https://qianfan.baidubce.com/v2",
    "api_type": "qianfan",
    "api_key": "api_key",  # your api_key
}

mllm_chat_bot_config = {
    "module_name": "chat_bot",
    "model_name": "PP-DocBee2",
    "base_url": "http://127.0.0.1:8080/",  # your local mllm service url
    "api_type": "openai",
    "api_key": "api_key",  # your api_key
}

pipeline = PPChatOCRv4Doc(
    layout_detection_model_name="PicoDet-S_layout_3cls",
)

visual_predict_res = pipeline.visual_predict(
    input="vehicle_certificate-1.png",
    use_doc_orientation_classify=False,
    use_doc_unwarping=False,
    use_common_ocr=True,
    use_seal_recognition=True,
    use_table_recognition=True,
)

visual_info_list = []
for res in visual_predict_res:
    visual_info_list.append(res["visual_info"])
    layout_parsing_result = res["layout_parsing_result"]

vector_info = pipeline.build_vector(
    visual_info_list, flag_save_bytes_vector=True, retriever_config=retriever_config
)
mllm_predict_res = pipeline.mllm_pred(
    input="vehicle_certificate-1.png",
    key_list=["驾驶室准乘人数"],
    mllm_chat_bot_config=mllm_chat_bot_config,
)
mllm_predict_info = mllm_predict_res["mllm_res"]
chat_result = pipeline.chat(
    key_list=["驾驶室准乘人数"],
    visual_info=visual_info_list,
    vector_info=vector_info,
    mllm_predict_info=mllm_predict_info,
    chat_bot_config=chat_bot_config,
    retriever_config=retriever_config,
)
print(chat_result)
```

The default model used in pipeline is `RT-DETR-H_layout_3cls`, so it is needed that specifing to `PicoDet-S_layout_3cls` by argument `layout_detection_model_name`. And you can also use the local model file by argument `layout_detection_model_dir`. For details about usage command and descriptions of parameters, please refer to the [Document](https://paddlepaddle.github.io/PaddleOCR/main/en/version3.x/pipeline_usage/PP-ChatOCRv4.html#2-quick-start).



## Links

[PaddleOCR Repo](https://github.com/paddlepaddle/paddleocr)

[PaddleOCR Documentation](https://paddlepaddle.github.io/PaddleOCR/latest/en/index.html)
