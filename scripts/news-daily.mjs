#!/usr/bin/env node
/**
 * 每日财经早报 —— 只抓取、只筛选、只罗列，不做任何分析或判断
 *
 * 数据源：东方财富 7×24 快讯 + 华尔街见闻快讯
 * 时间窗口：昨天 15:00（A股收盘）→ 现在
 * 产出：mail.html + mail_subject.txt（交给 scripts/sendmail.py 发送）
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const BJ = 8 * 3600 * 1000;              // 北京时间偏移
const NOW = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = async (u) => (await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } })).json();

// ── 时间窗口：昨天 15:00 北京 → 现在 ──────────────────────────────
// runner 是 UTC，所有北京墙上时间都必须显式换算，否则会差 8 小时
const bjWall = new Date(NOW + BJ);                 // 其 UTC 字段 == 北京墙上时间
const startWall = new Date(bjWall);
startWall.setUTCHours(15, 0, 0, 0);
if (startWall.getTime() > bjWall.getTime()) startWall.setUTCDate(startWall.getUTCDate() - 1);
const SINCE = new Date(startWall.getTime() - BJ);  // 还原成真实 epoch

const fmtHM = (d) => new Date(d.getTime() + BJ).toISOString().slice(11, 16);
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

// ── 源 1：东方财富 7×24 快讯（翻页直到越过窗口起点）─────────────
async function fetchEastmoney() {
  const out = [];
  let sortEnd = '';
  for (let page = 0; page < 30; page++) {
    const u = `https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724`
      + `&fastColumn=102&sortEnd=${encodeURIComponent(sortEnd)}&pageSize=100&req_trace=${page + 1}`;
    let j;
    try { j = await getJSON(u); } catch { break; }
    const list = j?.data?.fastNewsList || [];
    if (!list.length) break;
    let reached = false;
    for (const it of list) {
      // showTime 形如 "2026-09-12 10:58:01"，是北京时间 —— 必须带 +08:00
      const t = new Date(it.showTime.replace(' ', 'T') + '+08:00');
      if (t.getTime() < SINCE.getTime()) { reached = true; break; }
      if (!it.title) continue;
      out.push({ t, title: it.title.trim(), url: `https://finance.eastmoney.com/a/${it.code}.html`, src: '东财' });
    }
    if (reached) break;
    const next = j?.data?.sortEnd || '';
    if (!next || next === sortEnd) break;
    sortEnd = next;
    await sleep(250);                                 // 节流，别把人家接口打爆
  }
  return out;
}

// ── 源 2：华尔街见闻快讯（cursor 翻页）───────────────────────────
async function fetchWallstcn() {
  const out = [];
  for (const ch of ['a-stock-channel', 'global-channel']) {
    let cursor = '';
    for (let p = 0; p < 8; p++) {
      const u = `https://api-one.wallstcn.com/apiv1/content/lives?channel=${ch}&limit=100`
        + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      let j;
      try { j = await getJSON(u); } catch { break; }
      const items = j?.data?.items || [];
      if (!items.length) break;
      let reached = false;
      for (const it of items) {
        const t = new Date((it.display_time || 0) * 1000);   // unix 秒，无时区问题
        if (t.getTime() < SINCE.getTime()) { reached = true; break; }
        const raw = (it.title || it.content_text || '').trim();
        if (!raw) continue;
        // 没有标题的条目用正文首句，避免把整段正文塞进邮件
        const title = it.title ? raw.slice(0, 100) : raw.split(/[。；;]/)[0].slice(0, 70);
        if (!title) continue;
        out.push({ t, title, url: it.uri || '', src: '见闻' });
      }
      if (reached) break;
      cursor = j?.data?.next_cursor || j?.data?.cursor || '';
      if (!cursor) break;
      await sleep(250);
    }
  }
  return out;
}

// ── 分组规则：纯关键词准入，不含任何判断 ─────────────────────────
// hot  = 准入词（命中才收）
// warm = 备选词（该组不足 MIN_PER_GROUP 时，按时间回填）
// skip = 排除词（防止"波兰央行"这类混进国内组）
const GROUPS = [
  {
    key: 'macro', label: '🌍 海外 / 宏观',
    hot: /美联储|美债|FOMC|议息|鲍威尔|加息|降息|CPI|PPI|非农|通胀|原油|布伦特|油价|中东|以色列|伊朗|胡塞|沙特|霍尔木兹|关税|美股|纳斯达克|纳指|道琼斯|道指|标普|美元指数|欧洲央行|日本央行/,
    warm: /特朗普|俄罗斯|俄乌|乌克兰|黄金|白银|汇率|离岸人民币|欧佩克|国债收益率|能源|柴油|天然气/,
  },
  {
    key: 'hold', label: '📌 你的持仓相关',
    hot: /军工|国防|传媒|游戏|版号|半导体|芯片|光伏|硅料|硅片|新能源|碳酸锂|锂电池|储能|智能汽车|智能驾驶|智驾|车企/,
    warm: /航空|航天|导弹|影视|院线|短剧|晶圆|算力|光模块|科创|电池|汽车|充电桩|车市|乘用车|锂/,
  },
  {
    key: 'cn', label: '🇨🇳 国内 / 政策',
    hot: /证监会|国务院|发改委|财政部|人民银行|央行|降准|降息|LPR|MLF|逆回购|PMI|社融|A股|沪深|沪指|上证|深证|创业板|科创板|北向|IPO|退市|楼市|房地产|化债|金融监管/,
    warm: /工信部|商务部|政策|信贷|外资|监管|两市|电力|消费贷|中证|基金|券商|成交额/,
    skip: /波兰|巴西|俄罗斯|日本|欧洲|英国|韩国|印度|土耳其|印尼|泰国|越南|澳洲|加拿大|美国|德国|法国|瑞士|瑞典|挪威/,
  },
];

const MAX_PER_GROUP = 12;
const MIN_PER_GROUP = 7;
// 纯数据播报，不是新闻，统一剔除
const NOISE = /今日大宗交易|龙虎榜数据|融资余额播报|限售股解禁一览/;
const norm = (s) => s.replace(/[【】\[\]（）()：:，,。.、！!？?—\-–“”"'《》\s]/g, '');
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 专名指纹：英文词 + 数字（含万亿/%）
const tokens = (s) => new Set((s.match(/[A-Za-z][A-Za-z0-9.%-]*|\d+(?:\.\d+)?[万亿%]?/g) || []).map((x) => x.toLowerCase()));
// 中文二元组：识别"同一件事换个说法"（无英文数字的标题靠这个）
const bigrams = (s) => { const t = norm(s); const set = new Set(); for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2)); return set; };
const overlap = (a, b) => {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const x of a) if (b.has(x)) hit++;
  return hit / Math.min(a.size, b.size);
};

function build(all) {
  all.sort((a, b) => b.t - a.t);

  // 去重：标题前14字相同、专名指纹重合、或中文二元组重合 → 视为同一条
  const kept = [];
  for (const x of all) {
    const k = norm(x.title).slice(0, 14);
    if (!k || NOISE.test(x.title)) continue;
    x._k = k; x._tok = tokens(x.title); x._bg = bigrams(x.title);
    const dup = kept.some((y) => y._k === k
      || overlap(y._tok, x._tok) > 0.6
      || overlap(y._bg, x._bg) > 0.5);
    if (!dup) kept.push(x);
  }

  const groups = GROUPS.map((g) => ({ label: g.label, hot: [], warm: [] }));
  for (const item of kept) {
    let placed = false;
    GROUPS.forEach((g, i) => {
      if (placed || (g.skip && g.skip.test(item.title))) return;
      if (g.hot.test(item.title)) { groups[i].hot.push(item); placed = true; }
    });
    if (placed) continue;
    GROUPS.forEach((g, i) => {
      if (g.skip && g.skip.test(item.title)) return;
      if (g.warm.test(item.title)) groups[i].warm.push(item);
    });
  }

  // 每组：hot 优先（按时间倒序），不足 MIN 条时用 warm 回填
  return groups.map((g) => {
    const items = [...g.hot];
    if (items.length < MIN_PER_GROUP) {
      for (const w of g.warm) {
        if (items.length >= MIN_PER_GROUP) break;
        if (!items.some((x) => x._k === w._k)) items.push(w);
      }
    }
    items.sort((a, b) => b.t - a.t);
    return { label: g.label, items: items.slice(0, MAX_PER_GROUP) };
  }).filter((g) => g.items.length);
}

function render(groups, allCount) {
  const head = new Date(NOW + BJ);
  const dateCN = `${head.getUTCMonth() + 1}月${head.getUTCDate()}日 周${WEEK[head.getUTCDay()]}`;
  const n = groups.reduce((s, g) => s + g.items.length, 0);

  const body = groups.map((g) => `
    <h3 style="font-size:15px;margin:22px 0 8px;padding-bottom:6px;border-bottom:2px solid #e8e8e8;color:#111">
      ${g.label} <span style="color:#999;font-weight:400;font-size:13px">${g.items.length} 条</span>
    </h3>
    <ul style="padding-left:18px;margin:0">
      ${g.items.map((i) => `<li style="margin:7px 0;line-height:1.65;font-size:14px;color:#222">
        <span style="color:#aaa;font-size:12px;font-variant-numeric:tabular-nums">${fmtHM(i.t)}</span>
        ${i.url ? `<a href="${i.url}" style="color:#1a56db;text-decoration:none">${esc(i.title)}</a>`
                : esc(i.title)}
      </li>`).join('')}
    </ul>`).join('');

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f5">
<div style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;max-width:680px;margin:0 auto;padding:24px 20px;background:#fff;color:#1a1a1a">
  <h2 style="margin:0 0 4px;font-size:19px;color:#111">📰 财经早报 · ${dateCN}</h2>
  <p style="margin:0 0 4px;color:#999;font-size:12.5px">
    窗口 昨天 15:00 → 今天 ${fmtHM(new Date(NOW))} 　·　精选 ${n} 条 / 候选 ${allCount} 条
  </p>
  <p style="margin:0 0 18px;color:#999;font-size:12.5px">来源：东方财富 7×24 快讯、华尔街见闻</p>
  ${body}
  <p style="margin:26px 0 0;padding-top:12px;border-top:1px solid #eee;color:#bbb;font-size:12px">
    本邮件只做新闻筛选与罗列，不含任何分析或投资建议。
  </p>
</div></body></html>`;
}

// ── 主流程 ──────────────────────────────────────────────────────
// 防重：workflow 排了 8:30 和 8:50 两个槽（GitHub 定时可能跳/迟到），
// .news-last 记当天北京日期（由 workflow 提交回仓库），同一天只发一次
const TODAY_BJ = new Date(NOW + BJ).toISOString().slice(0, 10);
if (existsSync('.news-last') && readFileSync('.news-last', 'utf-8').trim() === TODAY_BJ) {
  console.log(`[跳过] ${TODAY_BJ} 已经发过了，不重复发`);
  process.exit(0);
}

const [em, wscn] = await Promise.all([fetchEastmoney(), fetchWallstcn()]);
const all = [...em, ...wscn];
console.log(`[抓取] 东财 ${em.length} 条 · 见闻 ${wscn.length} 条 · 窗口起点 ${new Date(SINCE.getTime() + BJ).toISOString().slice(0, 16).replace('T', ' ')} (北京)`);

const groups = build(all);
const n = groups.reduce((s, g) => s + g.items.length, 0);
groups.forEach((g) => console.log(`  ${g.label}: ${g.items.length} 条`));
console.log(`[结果] 精选 ${n} 条`);

if (n === 0) {
  console.log('没有抓到任何新闻，不生成邮件（避免发空邮件）');
  process.exit(0);
}

const head = new Date(NOW + BJ);
writeFileSync('mail.html', render(groups, all.length), 'utf-8');
writeFileSync('mail_subject.txt', `📰 财经早报 ${head.getUTCMonth() + 1}/${head.getUTCDate()} · ${n}条`, 'utf-8');
writeFileSync('.news-last', TODAY_BJ, 'utf-8');   // 由 workflow 提交回仓库，供下一槽防重
console.log(`[产出] mail.html + mail_subject.txt 已生成 · .news-last=${TODAY_BJ}`);
