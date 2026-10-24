// 工具声明：电话录音质检（自定义界面；语音识别和规则检查都在本机完成，不调用大模型）。
import { PhoneCall } from 'lucide-react';
import { createElement } from 'react';
import type { CustomTool } from '../kit/types';
import { Main } from './Main';

const tool: CustomTool = {
  id: 'o17',
  name: '电话录音质检',
  tagline: '批量导入通话录音，在本机离线转成文字，再按你配置的规则质检：必说话术是否说到、违禁词有没有出现、关键词出现几次，每通出得分和命中明细，导出 Excel 汇总。',
  icon: PhoneCall,
  category: '办公提效',
  type: 'media',
  mode: 'custom',
  mainLabel: '质检',
  params: [],
  Main: ({ ctx }) => createElement(Main, { ctx }),
};

export default tool;
