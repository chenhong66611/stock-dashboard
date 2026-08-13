#!/usr/bin/env python3
"""发送邮件（QQ邮箱 SMTP，纯标准库，GitHub Actions 环境自带 Python）"""
import os
import smtplib
import ssl

from email.mime.text import MIMEText
from email.utils import formataddr

SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.qq.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "465"))
SMTP_USER = os.environ["SMTP_USER"]          # 发件邮箱（QQ邮箱地址）
SMTP_CODE = os.environ["SMTP_CODE"]          # 授权码（GitHub Secrets 注入）
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
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ctx, timeout=30) as s:
        s.login(SMTP_USER, SMTP_CODE)
        s.sendmail(SMTP_USER, [SMTP_TO], msg.as_string())
    print(f"邮件已发送: {subject} -> {SMTP_TO}")

if __name__ == "__main__":
    main()
