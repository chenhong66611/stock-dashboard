"""
A股最小挂件 - 悬浮桌面，无边框，自动刷新
"""
import tkinter as tk
import urllib.request, threading, time, re

CODES = ['sh560010', 'sh588000', 'sh000688']
prices = {c: '--' for c in CODES}
changes = {c: '--' for c in CODES}
direction = {c: '' for c in CODES}

def fetch():
    while True:
        try:
            url = 'https://qt.gtimg.cn/q=' + ','.join(CODES)
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            r = urllib.request.urlopen(req, timeout=5)
            text = r.read().decode('gbk')
            for line in text.strip().split('\n'):
                m = re.match(r'^v_(\w+)="(.+)";?$', line)
                if not m: continue
                f = m.group(2).split('~')
                code = m.group(1)
                price = float(f[3]) if f[3] else 0
                prev = float(f[4]) if f[4] else 0
                chg = price - prev
                prices[code] = f'{price:.3f}'
                changes[code] = f'{"+"if chg>0 else""}{chg:.2f}'
                direction[code] = 'up' if chg > 0 else 'down' if chg < 0 else ''
        except:
            pass
        time.sleep(8)

root = tk.Tk()
root.title('')
root.overrideredirect(True)  # 无边框
root.attributes('-topmost', True)  # 置顶
root.attributes('-alpha', 0.75)  # 半透明
root.configure(bg='#1a1a1a')

# 拖动
def start_move(e):
    root._x, root._y = e.x, e.y
def do_move(e):
    root.geometry(f'+{e.x_root-root._x}+{e.y_root-root._y}')
root.bind('<Button-1>', start_move)
root.bind('<B1-Motion>', do_move)

# 关闭
def quit_(e=None): root.destroy()
root.bind('<Escape>', quit_)
root.bind('<Button-3>', quit_)  # 右键关

# grid 布局 - 自动紧凑
ROWS = [('1000', 'sh560010'), ('科创', 'sh588000'), ('指数', 'sh000688')]
labels = {}
for i, (label, code) in enumerate(ROWS):
    tk.Label(root, text=label, fg='#555', bg='#1a1a1a',
             font=('Consolas', 9)).grid(row=i, column=0, sticky='w',
                                        padx=(6, 4), pady=2)
    labels[code] = tk.Label(root, text='--', fg='#aaa', bg='#1a1a1a',
                            font=('Consolas', 10, 'bold'), anchor='e')
    labels[code].grid(row=i, column=1, sticky='e', pady=2)

# 涨跌列
chg_labels = {}
for i, (label, code) in enumerate(ROWS):
    chg_labels[code] = tk.Label(root, text='--', fg='#666', bg='#1a1a1a',
                                font=('Consolas', 9), anchor='e')
    chg_labels[code].grid(row=i, column=2, sticky='e', padx=(6, 14), pady=2)

# 计算窗口大小并定位右上角
root.update_idletasks()
w = root.winfo_reqwidth()
h = root.winfo_reqheight()
screen_w = root.winfo_screenwidth()
root.geometry(f'{w+54}x{h}+{screen_w-(w+54)-20}+60')

def update_ui():
    try:
        for code, p, c in [(c, labels[c], chg_labels[c]) for c in CODES]:
            p.config(text=prices[code])
            d = direction[code]
            clr = '#4ade80' if d=='up' else '#f87171' if d=='down' else '#666'
            c.config(text=changes[code], fg=clr)
    except: pass
    # 每次按内容自动调整窗口宽度，保证数字完整显示
    root.update_idletasks()
    w = root.winfo_reqwidth()
    h = root.winfo_reqheight()
    pos = root.geometry().split('+')
    root.geometry(f'{w-4}x{h}+{pos[1]}+{pos[2]}')
    root.after(3000, update_ui)

# start
update_ui()
threading.Thread(target=fetch, daemon=True).start()
root.mainloop()
