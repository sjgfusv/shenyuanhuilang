#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
深渊回廊 · 本地调试服务器
============================================================
为什么不用 python -m http.server：
  它只发 Last-Modified、**不发 Cache-Control**。手机浏览器会按"启发式缓存"
  把页面缓存很久 —— 表现就是「我改了代码，手机上刷新还是旧的」，
  排查时极其容易被误导（这次 2.7 的相机问题就差点栽在这上面）。
  本脚本给所有响应加 no-store，保证每次拿到的都是磁盘上的最新文件。

用法：
    python 其他/本地服务器.py [端口] [根目录]
    （默认端口 8123，默认根目录 = 本文件所在目录的上一级，即项目根）
"""
import os
import sys
import functools
import socketserver
import http.server

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
ROOT = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # 手机反复刷新时不要刷屏


class ThreadingServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def lan_ip():
    """取本机局域网 IP，方便手机调试。取不到就返回 None。"""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))  # 不会真的发包，只是让系统选出口网卡
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


if __name__ == '__main__':
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    with ThreadingServer(('0.0.0.0', PORT), handler) as httpd:
        # 注意：0.0.0.0 只是「监听所有网卡」的绑定地址，不能直接粘进浏览器
        # （浏览器会报 ERR_ADDRESS_INVALID），必须用 127.0.0.1 或 localhost。
        print('[深渊回廊] 本地服务器已启动，根目录 %s（已禁用缓存）' % ROOT)
        print('           本机访问： http://127.0.0.1:%d/' % PORT)
        ip = lan_ip()
        if ip:
            print('           手机访问： http://%s:%d/   （需同一 Wi-Fi）' % (ip, PORT))
        sys.stdout.flush()  # 被重定向/管道时也能立刻看到提示
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n[深渊回廊] 服务器已停止')
