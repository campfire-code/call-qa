# 第三方开源组件

本工具使用了以下开源组件，许可证原文见各项目仓库。

| 组件 | 用途 | 许可证 |
|---|---|---|
| [Tauri](https://github.com/tauri-apps/tauri) 及官方插件 | 桌面应用框架 | MIT / Apache-2.0 |
| [React](https://github.com/facebook/react) | 界面 | MIT |
| [Lucide](https://github.com/lucide-icons/lucide) | 图标 | ISC |
| [Vite](https://github.com/vitejs/vite) | 构建 | MIT |
| [FFmpeg](https://ffmpeg.org) 6.x 静态构建（取自 [eugeneware/ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) b6.1.1；Windows 版来自 gyan.dev） | 音视频处理，作为独立程序随应用分发 | GPL-3.0（许可证随安装包附在 licenses/ffmpeg-LICENSE.txt；源码见 https://ffmpeg.org/download.html） |
| [transformers.js](https://github.com/huggingface/transformers.js)（@huggingface/transformers 3.8.1） | 在应用内运行 Whisper 语音识别流程 | Apache-2.0 |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime)（1.22.0-dev.20250409，随 transformers.js 使用的版本） | 在本机用 WebAssembly 推理 | MIT |
| [OpenAI Whisper](https://github.com/openai/whisper) 模型权重（经 [Xenova/whisper-base](https://huggingface.co/Xenova/whisper-base)、[Xenova/whisper-small](https://huggingface.co/Xenova/whisper-small) 转换为 ONNX 8 位量化版，首次使用时下载，不随安装包分发） | 语音识别模型 | 原仓库 MIT；转换版 Hugging Face 模型卡标注 Apache-2.0 |
| [opencc-js](https://github.com/nk2028/opencc-js)（含 [OpenCC](https://github.com/BYVoid/OpenCC) 字典） | 繁体转简体 | MIT AND Apache-2.0 |
| [ExcelJS](https://github.com/exceljs/exceljs)（4.4.0） | 导出 Excel | MIT |
