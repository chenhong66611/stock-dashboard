"""
A股市场数据工具 - 整合可用数据源
"""
import json, urllib.request, sys

def fetch_json(url, timeout=10):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://quote.eastmoney.com/',
    })
    r = urllib.request.urlopen(req, timeout=timeout)
    return json.loads(r.read().decode('utf-8'))

def sector_overview():
    """板块涨跌排行"""
    url = "https://push2.eastmoney.com/api/qt/clist/get?cb=&pn=1&pz=30&po=1&np=1&fltt=2&invt=2&fs=m:90+t:2&fields=f12,f14,f3,f4,f62,f184,f66"
    try:
        data = fetch_json(url)
        items = data.get('data', {}).get('diff', [])
        print(f"{'板块':<12} {'涨跌幅':>8} {'主力净流入':>12}")
        print("-"*35)
        def to_num(v):
            try: return float(v) if v not in (None, '--', '') else 0
            except: return 0
        for item in items[:10]:
            name = item.get('f14', '')
            pct = to_num(item.get('f3', 0))
            inflow = to_num(item.get('f62', 0))
            inflow_str = f"{inflow/1e8:.2f}亿" if inflow else "--"
            print(f"{name:<12} {pct:>7.2f}% {inflow_str:>12}")
    except Exception as e:
        print(f"板块数据失败: {e}")

def capital_flow():
    """市场资金流向"""
    url = "https://push2.eastmoney.com/api/qt/clist/get?cb=&pn=1&pz=20&po=1&np=1&fltt=2&invt=2&fs=m:90+t:2&fields=f12,f14,f3,f62,f184,f66,f70,f78"
    try:
        data = fetch_json(url)
        items = data.get('data', {}).get('diff', [])
        def to_num(v):
            try: return float(v) if v not in (None, '--', '') else 0
            except: return 0
        total_in = sum(to_num(item.get('f62', 0)) for item in items)
        total_out = sum(to_num(item.get('f184', 0)) for item in items)
        print(f"行业主力净流入合计: {total_in/1e8:.1f}亿")
        print(f"行业主力净流出合计: {abs(total_out)/1e8:.1f}亿")
        print()
        print(f"{'净流入TOP5':<15} {'流入(亿)':>10}")
        sorted_in = sorted(items, key=lambda x: to_num(x.get('f62', 0)), reverse=True)[:5]
        for item in sorted_in:
            v = to_num(item.get('f62', 0)) / 1e8
            if v > 0:
                print(f"  {item['f14']:<13} {v:>8.1f}亿")
        print(f"{'净流出TOP5':<15} {'流出(亿)':>10}")
        sorted_out = sorted(items, key=lambda x: to_num(x.get('f184', 0)), reverse=True)[:5]
        for item in sorted_out:
            v = abs(to_num(item.get('f184', 0))) / 1e8
            if v > 0:
                print(f"  {item['f14']:<13} {v:>8.1f}亿")
    except Exception as e:
        print(f"资金流向失败: {e}")

def market_overview():
    """大盘概览"""
    url = "https://push2.eastmoney.com/api/qt/ulist.np/get?cb=&fltt=2&fields=f2,f3,f4,f12,f14&secids=1.000001,0.399001,0.399006,1.000688,1.000852"
    try:
        data = fetch_json(url)
        items = data.get('data', {}).get('diff', [])
        print(f"{'指数':<12} {'最新':>8} {'涨跌幅':>8}")
        print("-"*30)
        for item in items:
            name = item.get('f14', '')
            price = item.get('f2', 0)
            pct = item.get('f3', 0)
            print(f"{name:<12} {price:>8.2f} {pct:>7.2f}%")
    except Exception as e:
        print(f"大盘数据失败: {e}")

def fund_flow_real():
    """实时资金流向（上证）"""
    url = "https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?cb=&secid=1.000001&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55&klt=1&lmt=5"
    try:
        data = fetch_json(url)
        print("资金流向数据:", json.dumps(data, ensure_ascii=False, indent=2)[:500])
    except Exception as e:
        print(f"实时资金流向失败: {e}")

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'help'
    if cmd == 'sector':
        sector_overview()
    elif cmd == 'flow':
        capital_flow()
    elif cmd == 'market':
        market_overview()
    elif cmd == 'all':
        print("=== 大盘 ===")
        market_overview()
        print()
        print("=== 板块涨跌 ===")
        sector_overview()
        print()
        print("=== 资金流向 ===")
        capital_flow()
    else:
        print("用法: python market-data.py [sector|flow|market|all]")
