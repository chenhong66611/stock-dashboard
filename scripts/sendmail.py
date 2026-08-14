#!/usr/bin/env python3
"""发送邮件（支持 QQ 邮箱 465 SSL 和 Outlook 587 STARTTLS，纯标准库）"""
import os
import smtplib
import ssl

from email.mime.text import MIMEText
from email.utils import formataddr

# 默认 Outlook（GitHub 服务器在境外，连 smtp.office365.com 稳定）
SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.office365.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ["SMTP_USER"]          # 发件邮箱
SMTP_CODE = os.environ["SMTP_CODE"]          # 应用密码 / 授权码（GitHub Secrets 注入）
SMTP_TO = os.environ.get("SMTP_TO", SMTP_USER)  # 收件邮箱，默认发给自己

def main():
    with open("mail.html", encoding="utf-8") as f:
        body = f.read()
    with open("mail_subject.txt", encoding="utf-8") as f:
        subject = f.read().strip()

    msg = MIMEText(body, "html", "utf-8")
    msg["Subject"] = subject
    msg["From"] = formataddr(("ETF量能助手", SMTP_USER))
    msg["To"] = SMTP_TO

    ctx = ssl.create_default_context()
    if SMTP_PORT == 465:
        # QQ邮箱等：SSL直连
        s = smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ctx, timeout=30)
    else:
        # Outlook等：STARTTLS
        s = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30)
        s.starttls(context=ctx)
    with s:
        s.login(SMTP_USER, SMTP_CODE)
        s.sendmail(SMTP_USER, [SMTP_TO], msg.as_string())
    print(f"邮件已发送: {subject} -> {SMTP_TO}")

if __name__ == "__main__":
    main()
