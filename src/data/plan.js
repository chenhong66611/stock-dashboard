/**
 * 交易计划 —— 2026-09-16 制定
 *
 * ⚠️ 重要：这个文件会被打包进【公开网站】的 JS 里（GitHub Pages 是公开的）。
 *     所以这里绝对不能放真实金额：现金、总资产、成本价、份数、市值 —— 一律不放。
 *     卖出量用「占该仓位的百分比」表示，一样能执行，但不泄露仓位规模。
 *     完整版（含金额）在电脑桌面：持仓档位计划表_2026-09-16.txt
 *
 * 改计划：只改这个文件，不用碰组件。
 * 所有价格都是「绝对价格」，定了就不随行情重算。
 *
 * 字段：
 *   stop   认错线，触发即全清，最高优先级
 *   sells  卖出档（从高到低），pct = 卖出量占该仓位的百分比
 *   buys   买入档（下方历史成交密集区），每档固定金额
 */

export const PLAN_DATE = '2026-09-16'

/** 买入档每档投入的金额（只用于算「买几份」，不含总资产信息） */
export const BUY_UNIT = 300

export const PLAN = [
  {
    code: 'sh512710',
    name: '军工龙头',
    stop: { price: 0.582, note: '成本线，白干一场就走' },
    sells: [
      { price: 0.850, pct: 24, note: '你原定目标价' },
      { price: 0.790, pct: 24, note: '' },
      { price: 0.724, pct: 29, note: '夹住你原定的 0.70' },
      { price: 0.680, pct: 24, note: '' },
    ],
    buys: [
      { price: 0.617, stopDays: 43 },
      { price: 0.605, stopDays: 35 },
      { price: 0.542, stopDays: 37 },
    ],
  },
  {
    code: 'sh515250',
    name: '智能汽车',
    stop: { price: 0.825, note: '硬线，无条件' },
    sells: [
      { price: 1.041, pct: 40, note: '' },
      { price: 0.969, pct: 30, note: '' },
      { price: 0.930, pct: 30, note: '回本' },
    ],
    buys: [],
    footnote: '已减仓一次。不再加仓。10/31 强制复评。',
  },
  {
    code: 'sz159869',
    name: '游戏',
    stop: { price: 0.991, note: '' },
    sells: [
      { price: 1.314, pct: 43, note: '到达率 67%' },
      { price: 1.239, pct: 29, note: '到达率 83%' },
      { price: 1.163, pct: 29, note: '到达率 83%' },
    ],
    buys: [
      { price: 0.948, stopDays: 73 },
      { price: 0.926, stopDays: 58 },
      { price: 0.775, stopDays: 68 },
    ],
  },
  {
    code: 'sh512980',
    name: '传媒',
    stop: { price: 0.743, note: '' },
    sells: [
      { price: 0.986, pct: 33, note: '到达率 50%' },
      { price: 0.929, pct: 33, note: '到达率 60%' },
      { price: 0.873, pct: 33, note: '到达率 60%' },
    ],
    buys: [
      { price: 0.792, stopDays: 94 },
      { price: 0.760, stopDays: 93 },
      { price: 0.695, stopDays: 103 },
    ],
  },
  {
    code: 'sh515790',
    name: '光伏',
    stop: { price: 0.735, note: '' },
    sells: [
      { price: 0.975, pct: 33, note: '到达率 43%' },
      { price: 0.919, pct: 33, note: '到达率 43%' },
      { price: 0.863, pct: 33, note: '到达率 43%' },
    ],
    buys: [
      { price: 0.751, stopDays: 37 },
      { price: 0.655, stopDays: 36 },
      { price: 0.639, stopDays: 37 },
    ],
  },
]

/** 铁律 */
export const RULES = [
  '档位不是临场想的，是历史数据算的。到了就执行，不重新分析。',
  '想说「这次不一样」的时候，先回来看这一页。',
  '任何档位要改，只能盘后改，不能盘中改。',
  '卖飞不可耻，扛单才可耻。已经卖飞的（科创50）不要再想了。',
  '单一标的永远不超过总资产 15%。',
  '单季换手不超过总资产的 50%。',
]
