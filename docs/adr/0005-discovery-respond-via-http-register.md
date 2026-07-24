# ADR-0005: 发现回应改为 HTTP 定向 register,不扫网段

- 状态: 已接受(v0.5.1 发布)

## 背景与问题

双向发现的"回应"原走 UDP 多播回一发 announce。纯多播脆弱(交换机 IGMP、AP 过滤多播、代理隧道抢网卡),回应单向丢包时对方永远发现不了我们。收到 announce 时已握有对方 IP + HTTP 端口,定向回应的信息是齐全的。

## 备选项

1. **HTTP 定向 `POST /register` 回应**(LocalSend 协议"用法 A",走 TCP 单播)
2. 维持 UDP 多播回应——否决:多播被过滤时回应到不了,正是要治的病
3. HTTP 扫网段——否决(用户明确):行为像横向扫描,会触发企业 EDR 告警
4. UDP 广播回应——否决:本次只做定向回应;广播通道后续单独决策(见 ADR-0006,且那是 announce 侧不是回应侧)

## 决策

选定**方案 1**:收到多播 announce 后改用 `POST /register` 定向回应对方,**去掉**原 UDP 多播回应。

## 后果

- 正面:回应走 TCP 单播,不受多播过滤影响,双向发现成功率显著提升。
- 负面/已知坑:register 响应体省略 port,不能拿它刷新登记(见来源 §2.2)。

## 来源

[discovery-http-register-response.md](../discovery-http-register-response.md)。
