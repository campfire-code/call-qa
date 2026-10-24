// 示例规则与预览用的示例数据（内容均为自编，标明「示例」）。
import type { Segment } from './asr';
import type { Config } from './core';

export const DEFAULT_CONFIG: Config = {
  passScore: 80,
  rules: [
    { id: 'd1', kind: 'required', name: '开场问候（示例）', words: ['您好', '你好', '早上好', '下午好', '晚上好'], penalty: 15, withinSec: 15 },
    { id: 'd2', kind: 'required', name: '报身份（示例）', words: ['客服中心', '工号', '公号', '为您服务', '很高兴为您服务'], penalty: 15, withinSec: 20 },
    { id: 'd3', kind: 'required', name: '结束语（示例）', words: ['感谢您的来电', '祝您生活愉快', '再见'], penalty: 10 },
    { id: 'd4', kind: 'banned', name: '绝对化承诺（示例）', words: ['绝对', '保证', '百分之百', '肯定没问题', '包您满意'], penalty: 30 },
    { id: 'd5', kind: 'banned', name: '不当用语（示例）', words: ['别投诉', '爱买不买', '没别的事我先挂了', '先挂了'], penalty: 30 },
    { id: 'd6', kind: 'keyword', name: '退款（示例）', words: ['退款', '退钱', '退货'], penalty: 0, min: 0, max: 0 },
    { id: 'd7', kind: 'keyword', name: '投诉（示例）', words: ['投诉', '举报', '12315'], penalty: 0, min: 0, max: 0 },
  ],
};

// 下面三通是示例录音（samples/ 里）用 small 模型在本机识别出来的真实结果（含「势力」「公号」这类同音字误识别），用于预览与测试。
export const DEMO: { name: string; duration: number; segs: Segment[] }[] = [
  { name: '示例通话A-合格.mp3', duration: 28.9, segs: [
    { start: 0, end: 8, text: '您好，这里是势力客服中心，公号103，很高兴为您服务。请问是您本人吗？' },
    { start: 9, end: 14.3, text: '好的，请您提供一下订单号后四位，我帮您查询。' },
    { start: 15.3, end: 23.3, text: '已经查到了，订单金天下午发货，预计后天送达，请问还有其他可以帮您的吗？' },
    { start: 24.3, end: 28.3, text: '感谢您的来电，祝您生活愉快，再见。' },
  ] },
  { name: '示例通话B-违规.m4a', duration: 15.5, segs: [
    { start: 0, end: 1.28, text: '喂，请讲。' },
    { start: 2.3, end: 9.22, text: '我们的产品绝对没有质量问题，我保证您用了肯定满意，您就别投诉了。' },
    { start: 10.5, end: 14.86, text: '退款3-5个工作日到长，没别的是我先挂了。' },
  ] },
  { name: '示例通话C-漏说.wav', duration: 19, segs: [
    { start: 0, end: 2.8, text: '您好，请问有什么可以帮您？' },
    { start: 3.96, end: 11.8, text: '退款需要审核，退款到帐一般要3-5个工作日，您的退款已经在审核中了。' },
    { start: 12.8, end: 18.8, text: '非常抱歉给您带来补便，我们会尽快处理，请您耐心等待。' },
  ] },
];
