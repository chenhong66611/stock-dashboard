/**
 * 板块行情数据服务
 * 数据源：腾讯股票 API (qt.gtimg.cn) —— 行业一级板块，对应申万一级 31 个
 *
 * 说明：
 * 1. 板块代码硬编码在本地，名称也走本地常量，不从接口取中文 —— 接口是 GBK 编码，
 *    按 UTF-8 解会乱码，只读数字字段就没这个问题（与 stockApi.js 同样的处理方式）。
 * 2. 板块代码前缀 pt 表示"板块"，01801110 这类编码是腾讯自己的行业分类。
 * 3. 一次请求即可拿全部 31 个板块，接口带 Access-Control-Allow-Origin: *，浏览器可直连。
 */

export const SECTORS = [
  { code: 'pt01801010', name: '农林牧渔' },
  { code: 'pt01801030', name: '基础化工' },
  { code: 'pt01801040', name: '钢铁' },
  { code: 'pt01801050', name: '有色金属' },
  { code: 'pt01801080', name: '电子' },
  { code: 'pt01801110', name: '家用电器' },
  { code: 'pt01801120', name: '食品饮料' },
  { code: 'pt01801130', name: '纺织服饰' },
  { code: 'pt01801140', name: '轻工制造' },
  { code: 'pt01801150', name: '医药生物' },
  { code: 'pt01801160', name: '公用事业' },
  { code: 'pt01801170', name: '交通运输' },
  { code: 'pt01801180', name: '房地产' },
  { code: 'pt01801200', name: '商贸零售' },
  { code: 'pt01801210', name: '社会服务' },
  { code: 'pt01801230', name: '综合' },
  { code: 'pt01801710', name: '建筑材料' },
  { code: 'pt01801720', name: '建筑装饰' },
  { code: 'pt01801730', name: '电力设备' },
  { code: 'pt01801740', name: '国防军工' },
  { code: 'pt01801750', name: '计算机' },
  { code: 'pt01801760', name: '传媒' },
  { code: 'pt01801770', name: '通信' },
  { code: 'pt01801780', name: '银行' },
  { code: 'pt01801790', name: '非银金融' },
  { code: 'pt01801880', name: '汽车' },
  { code: 'pt01801890', name: '机械设备' },
  { code: 'pt01801950', name: '煤炭' },
  { code: 'pt01801960', name: '石油石化' },
  { code: 'pt01801970', name: '环保' },
  { code: 'pt01801980', name: '美容护理' },
]

// 自己持仓涉及的一级板块（只记板块名，不涉及金额）
// 军工龙头→国防军工  传媒/游戏→传媒  光伏→电力设备
export const HELD_SECTORS = ['国防军工', '传媒', '电力设备']

/**
 * 全市场细分板块 —— 27 个行业拆到二级（78 块），
 * 计算机/通信/机械设备/非银金融/汽车 等 12 个腾讯没给完整二级的行业退回一级本身。
 * 结果是 90 块，互不重叠，加起来正好等于 31 个一级的总和（实测 16545 vs 16548 亿）。
 */
export const BOARDS = [
  { code: 'pt01801081', name: '半导体' },
  { code: 'pt01801890', name: '机械设备' },
  { code: 'pt01801770', name: '通信' },
  { code: 'pt01801083', name: '元件' },
  { code: 'pt01801750', name: '计算机' },
  { code: 'pt01801760', name: '传媒' },
  { code: 'pt01801880', name: '汽车' },
  { code: 'pt01801085', name: '消费电子' },
  { code: 'pt01801737', name: '电池' },
  { code: 'pt01801084', name: '光学光电子' },
  { code: 'pt01801151', name: '化学制药' },
  { code: 'pt01801735', name: '光伏设备' },
  { code: 'pt01801161', name: '电力' },
  { code: 'pt01801010', name: '农林牧渔' },
  { code: 'pt01801055', name: '工业金属' },
  { code: 'pt01801156', name: '医疗服务' },
  { code: 'pt01801790', name: '非银金融' },
  { code: 'pt01801034', name: '化学制品' },
  { code: 'pt01801036', name: '塑料' },
  { code: 'pt01801738', name: '电网设备' },
  { code: 'pt01801170', name: '交通运输' },
  { code: 'pt01801086', name: '电子化学品' },
  { code: 'pt01801200', name: '商贸零售' },
  { code: 'pt01801054', name: '小金属' },
  { code: 'pt01801745', name: '军工电子' },
  { code: 'pt01801125', name: '白酒' },
  { code: 'pt01801153', name: '医疗器械' },
  { code: 'pt01801960', name: '石油石化' },
  { code: 'pt01801782', name: '国有大型银行' },
  { code: 'pt01801712', name: '玻璃玻纤' },
  { code: 'pt01801783', name: '股份制银行' },
  { code: 'pt01801742', name: '航空装备' },
  { code: 'pt01801784', name: '城商行' },
  { code: 'pt01801152', name: '生物制品' },
  { code: 'pt01801181', name: '房地产开发' },
  { code: 'pt01801082', name: '其他电子' },
  { code: 'pt01801155', name: '中药' },
  { code: 'pt01801971', name: '环境治理' },
  { code: 'pt01801053', name: '贵金属' },
  { code: 'pt01801033', name: '化学原料' },
  { code: 'pt01801733', name: '其他电源设备' },
  { code: 'pt01801210', name: '社会服务' },
  { code: 'pt01801951', name: '煤炭开采' },
  { code: 'pt01801056', name: '能源金属' },
  { code: 'pt01801038', name: '农化制品' },
  { code: 'pt01801111', name: '白色家电' },
  { code: 'pt01801132', name: '服装家纺' },
  { code: 'pt01801116', name: '家电零部件' },
  { code: 'pt01801141', name: '包装印刷' },
  { code: 'pt01801736', name: '风电设备' },
  { code: 'pt01801142', name: '家居用品' },
  { code: 'pt01801723', name: '基础建设' },
  { code: 'pt01801127', name: '饮料乳品' },
  { code: 'pt01801743', name: '地面兵装' },
  { code: 'pt01801731', name: '电机' },
  { code: 'pt01801724', name: '专业工程' },
  { code: 'pt01801741', name: '航天装备' },
  { code: 'pt01801163', name: '燃气' },
  { code: 'pt01801051', name: '金属新材料' },
  { code: 'pt01801744', name: '航海装备' },
  { code: 'pt01801154', name: '医药商业' },
  { code: 'pt01801113', name: '小家电' },
  { code: 'pt01801131', name: '纺织制造' },
  { code: 'pt01801713', name: '装修建材' },
  { code: 'pt01801726', name: '工程咨询' },
  { code: 'pt01801114', name: '厨卫电器' },
  { code: 'pt01801980', name: '美容护理' },
  { code: 'pt01801115', name: '照明设备' },
  { code: 'pt01801722', name: '装修装饰' },
  { code: 'pt01801124', name: '食品加工' },
  { code: 'pt01801143', name: '造纸' },
  { code: 'pt01801711', name: '水泥' },
  { code: 'pt01801785', name: '农商行' },
  { code: 'pt01801044', name: '普钢' },
  { code: 'pt01801128', name: '休闲食品' },
  { code: 'pt01801129', name: '调味发酵品' },
  { code: 'pt01801231', name: '综合' },
  { code: 'pt01801039', name: '非金属材料' },
  { code: 'pt01801032', name: '化学纤维' },
  { code: 'pt01801133', name: '饰品' },
  { code: 'pt01801721', name: '房屋建设' },
  { code: 'pt01801112', name: '黑色家电' },
  { code: 'pt01801972', name: '环保设备' },
  { code: 'pt01801126', name: '非白酒' },
  { code: 'pt01801037', name: '橡胶' },
  { code: 'pt01801183', name: '房地产服务' },
  { code: 'pt01801045', name: '特钢' },
  { code: 'pt01801952', name: '焦炭' },
  { code: 'pt01801043', name: '冶钢原料' },
  { code: 'pt01801145', name: '文娱用品' },
]

/** 腾讯板块行情的字段下标（实测 63 个字段确认过，和 ETF 的解析不同） */
const F = {
  time: 30,     // 数据时间 20261113150247
  pct: 32,      // 涨跌幅 %
  amount: 37,   // 成交额（万元）
  turnover: 38, // 换手率 %
  floatCap: 44, // 流通市值（亿）
  volRatio: 49, // 量比
  type: 58,     // BK-HY-1 = 行业一级板块
}

/**
 * 拉取 31 个一级板块的实时行情
 * @returns {Promise<Array>} [{ code, name, pct, amount(亿), turnover, floatCap, volRatio, time }]
 */
/** 31 个申万一级行业 */
export async function fetchSectors() {
  return fetchList(SECTORS)
}

/** 90 个细分板块（二级为主，一级兜底），一次请求全拿 */
export async function fetchBoards() {
  return fetchList(BOARDS)
}

async function fetchList(list) {
  const codes = list.map(s => s.code).join(',')
  const resp = await fetch(`https://qt.gtimg.cn/q=${codes}`)
  if (!resp.ok) throw new Error(`请求失败 (${resp.status})`)

  const text = await resp.text()
  if (!text || text.includes('FAILED')) {
    throw new Error('数据源返回异常，请稍后重试')
  }
  return parseList(text, list)
}

function parseList(text, list) {
  // 每行形如：v_pt01801010="2~农林牧渔~01801010~..."
  const fieldsByCode = new Map()
  for (const seg of text.split(';')) {
    const m = seg.trim().match(/^v_(\w+)="(.+)"$/)
    if (!m) continue
    fieldsByCode.set(m[1], m[2].split('~'))
  }

  const items = []
  for (const meta of list) {
    const f = fieldsByCode.get(meta.code)
    if (!f || f.length < 59) continue

    const amountWan = parseFloat(f[F.amount]) || 0
    items.push({
      code: meta.code,
      name: meta.name,
      pct: parseFloat(f[F.pct]) || 0,
      amount: amountWan / 1e4,               // 万元 → 亿元
      turnover: parseFloat(f[F.turnover]) || 0,
      floatCap: parseFloat(f[F.floatCap]) || 0,
      volRatio: parseFloat(f[F.volRatio]) || 0,
      time: f[F.time] || '',
      isLevel1: f[F.type] === 'BK-HY-1',
    })
  }
  return items
}

/** 20261113150247 → 11-13 15:02 */
export function formatDataTime(raw) {
  if (!raw || raw.length < 14) return '--'
  return `${raw.slice(4, 6)}-${raw.slice(6, 8)} ${raw.slice(8, 10)}:${raw.slice(10, 12)}`
}

/** 成交额：亿元 → 可读字符串 */
export function formatAmountYi(val) {
  if (!val || isNaN(val)) return '--'
  if (val >= 1e4) return (val / 1e4).toFixed(2) + '万亿'
  if (val >= 100) return val.toFixed(0) + '亿'
  return val.toFixed(1) + '亿'
}

/** 涨跌幅 → +1.47% */
export function formatPct(val) {
  if (val == null || isNaN(val)) return '--'
  return (val > 0 ? '+' : '') + val.toFixed(2) + '%'
}

/**
 * 色阶强度。线性映射会让小涨小跌在深色底上糊成褐色（当天最大跌幅 4.97% 会把
 * 整条色阶拉满，+1.47% 只剩三成强度），所以做一次 0.62 次幂的感知提亮。
 * 端点不变：涨跌 0 仍是"什么都没发生"，最大幅值仍是最饱和。
 */
function ramp(pct, maxAbs) {
  return Math.pow(Math.min(1, Math.abs(pct) / maxAbs), 0.62)
}

/**
 * 发散色阶：红(涨) ← 中性灰 → 绿(跌)，中点为"什么都没发生"
 * 红绿是 A 股约定，但对红绿色盲不友好 —— 所以每个方块都直接写出数字，
 * 颜色永远不是唯一的信息通道。
 */
export function sectorFill(pct, maxAbs) {
  const t = ramp(pct, maxAbs)
  if (pct > 0) return `rgba(242, 54, 69, ${(0.10 + 0.80 * t).toFixed(3)})`
  if (pct < 0) return `rgba(0, 200, 83, ${(0.10 + 0.80 * t).toFixed(3)})`
  return 'rgba(255, 255, 255, 0.05)'
}

/** 背景够深就用白字，否则用常规文字色 —— 保证对比度 */
export function sectorTextTone(pct, maxAbs) {
  return ramp(pct, maxAbs) >= 0.5 ? 'light' : 'normal'
}

/** 所有板块里 |涨跌幅| 的最大值，至少 1%，平淡日不至于饱和 */
export function maxAbsPct(items) {
  return Math.max(1, ...items.map(i => Math.abs(i.pct)))
}
