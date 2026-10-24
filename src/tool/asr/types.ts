// 语音识别模块的公共类型。本目录（src/tool/asr）不依赖界面，可整体复制给其他语音工具复用。

/** 一条字幕：时间单位为秒 */
export interface Segment {
  start: number;
  end: number;
  text: string;
}

/** 识别器对一个音频窗口（不超过 30 秒）的原始输出，时间相对窗口开头；end 可能缺失 */
export interface RawPiece {
  text: string;
  start: number;
  end: number | null;
}

/** 识别函数：输入 16kHz 单声道音频，返回带时间戳的片段。真实实现见 whisper.ts，测试里用假函数。 */
export type Recognize = (audio: Float32Array, opt: { language: string }) => Promise<RawPiece[]>;

export const SAMPLE_RATE = 16000;
