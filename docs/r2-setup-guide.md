# Cloudflare R2 接入手册(傻瓜清单)

> 目标:让 GitHub Actions 发版时把安装包自动推到 R2,中国以外用户从 R2 下载。
> 全程你在浏览器点按钮 + 复制粘贴,不用懂原理。**涉及付款/密钥的都由你亲手做。**

R2 免费额度(个人项目基本 $0):**10 GB 存储 + egress(下载流量)免费**。开通需绑卡(超额才扣费,不会误扣)。

---

## 前置:你需要先有

- [ ] 一个 **Cloudflare 账号**(没有就先注册 https://dash.cloudflare.com/sign-up)。
- [ ] 一个**域名,且已加到这个 Cloudflare 账号**(自定义下载域 `dl.你的域名` 必须与 R2 同账户)。
  - 若域名还没买/没接入 Cloudflare:先做完"域名接入"再回来。可以先跳过自定义域(第 5 步),用免费 `r2.dev` 地址临时顶着,后面再补。

---

## 第 1 步:开通 R2

1. 登录 Cloudflare 面板 → 左侧菜单找 **R2 Object Storage**。
2. 点进去,如果第一次用,会让你**同意条款 + 绑定支付方式**(信用卡)。绑好即开通。
   - ⚠️ 这一步是你亲自做(涉及付款信息,我不能代做)。

## 第 2 步:建桶(Bucket)

1. R2 页面点 **Create bucket**。
2. **Bucket name** 填:`transfer-releases`(记住这个名字,后面填 secret 要用)。
3. Location 选 **Automatic**(自动就近),点 **Create bucket**。

> 📌 记下:`R2_BUCKET = transfer-releases`

## 第 3 步:拿到 Account ID

1. 在 R2 主页面右侧(或桶的 Settings 里),找到 **Account ID**(一串 32 位十六进制)。
2. 复制它。

> 📌 记下:`R2_ACCOUNT_ID = <你复制的那串>`
> S3 端点会是 `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`(CI 里自动拼,你不用手填)。

## 第 4 步:生成 API Token(拿密钥)

1. R2 主页面 → **Account Details** 区域 → **API Tokens** → **Manage API Tokens**(或 **Create API Token**)。
2. 点 **Create API Token**。
3. **Permissions** 选 **Object Read & Write**(读写对象即可,不用 Admin)。
4. **Specify bucket(s)**:选 **Apply to specific buckets only** → 勾 `transfer-releases`(最小权限,只让它动这一个桶)。
5. TTL 可留默认(不过期)或按需。点 **Create API Token**。
6. 生成后会显示三样东西,**Secret Access Key 只显示这一次**,当场复制好:
   - **Access Key ID** → `R2_ACCESS_KEY_ID`
   - **Secret Access Key** → `R2_SECRET_ACCESS_KEY`
   - (页面可能还给一个 S3 endpoint,已含 Account ID,可核对)

> 📌 记下:`R2_ACCESS_KEY_ID` 和 `R2_SECRET_ACCESS_KEY`(Secret 关页就看不到了,务必先存好)。

## 第 5 步:给桶绑自定义下载域(可后补)

> 让下载地址是 `https://dl.你的域名/releases/v0.9.0/xxx.dmg`,而不是难记的 r2.dev。
> **前提:域名已在同一 Cloudflare 账户。** 没接好可先跳过,用第 5b 顶着。

1. 进桶 → **Settings** → **Custom Domains** → **Add**。
2. 填 `dl.你的域名`(如 `dl.transfer.app`),继续。
3. 它会显示要加的 DNS 记录,确认 **Connect Domain**。
4. 状态几分钟内从 Initializing 变 **Active**,自定义域就通了。

### 第 5b 步(备选):不绑自定义域,先用 r2.dev

- 桶 → Settings → **Public Development URL** → Enable → 输入 `allow` 确认。
- 会得到一个 `https://pub-xxxx.r2.dev` 地址(**有限流,仅测试用**,正式建议还是绑自定义域)。

## 第 6 步:把 4 个密钥填进 GitHub Secrets

1. 打开仓库:https://github.com/zhoulf1006/transfer/settings/secrets/actions
2. 点 **New repository secret**,逐个添加(名字**必须完全一致**):

   | Secret 名 | 值 |
   |-----------|-----|
   | `R2_ACCOUNT_ID` | 第 3 步的 Account ID |
   | `R2_ACCESS_KEY_ID` | 第 4 步的 Access Key ID |
   | `R2_SECRET_ACCESS_KEY` | 第 4 步的 Secret Access Key |
   | `R2_BUCKET` | `transfer-releases` |

   > `GITEE_PAT` 你已经加过了。

3. 加完这 4 个,CI 的 R2 步骤就会从"跳过"变成"执行"。

---

## 第 7 步:告诉我两件事,我来收尾

填完 secret 后,把这两个值发我(**不是密钥,是公开信息**):

1. 你的**自定义下载域**(如 `dl.transfer.app`),或者 r2.dev 地址。
2. 你的**落地页域名**(如 `transfer.app`)。

我会:
- 把 `site/src/download-config.ts` 里的占位 `dl.example.com` 换成你的真实下载域。
- 把 `astro.config.mjs` 的 `site` 换成你的落地页域名。

---

## 第 8 步:打测试 tag 验证全链路

准备好后(可以先用预发布 tag,不影响正式版):

```bash
git tag v0.9.1-beta
git push origin v0.9.1-beta
```

CI 会:打包 → 发 GitHub Release → 推 R2 → 镜像 Gitee。跑完我帮你读日志,确认:
- R2 里有没有 `releases/v0.9.1-beta/*.dmg` 和 `latest.json`;
- Gitee 有没有那 3 个小文件;
- 下载链接能不能点开。

有问题我来排。

---

## 常见疑问

- **会扣钱吗?** 免费额度内不会。你的包一版 ~530MB,10GB 能放十几版;egress(下载流量)R2 免费。
- **密钥泄露了怎么办?** 回第 4 步删掉旧 Token、重新生成,更新 GitHub Secrets 即可。
- **只想先试,不想绑卡?** R2 必须绑卡才能开(Cloudflare 要求)。不想绑就先只上 Pages + Gitee,下载指向 GitHub/Gitee,R2 以后再加。
