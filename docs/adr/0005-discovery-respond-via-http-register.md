# ADR-0005: 发现回应改为 HTTP 定向 register,不扫网段

- 状态: 已接受(v0.5.1 发布)

## 背景

双向发现的"回应"原走 UDP 多播回一发 announce。纯多播脆弱(交换机 IGMP、AP 过滤多播、代理隧道抢网卡),单向丢包时对方永远发现不了我们。收到 announce 时已握有对方 IP + HTTP 端口,定向回应的信息是齐全的。

## 决策

只做 LocalSend 协议"用法 A":收到多播 announce 后,改用 `POST /register` **定向 TCP** 回应对方;**去掉原 UDP 多播回应**。明确**不扫网段、不广播回应**——扫网段像横向扫描,会触发企业 EDR 告警。

## 后果

- 回应走 TCP 单播,不再受多播过滤影响,双向发现成功率显著提升。
- 已知坑:register 响应体省略 port,不能拿它刷新登记(见来源 §2.2)。

## 来源

[discovery-http-register-response.md](../discovery-http-register-response.md)。
