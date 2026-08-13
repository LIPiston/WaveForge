# 爱发电赞助名单同步

“关于”页的赞助名单来自 `src/data/afdianSponsors.generated.json`。同步脚本调用爱发电开放平台的 `query-sponsor` 接口，只保留当前页面中 **50.00 元**和 **88.88 元**两个档位，并按 `first_pay_time`（首次赞助时间）从早到晚排序。

## 配置

1. 登录爱发电创作者后台，在开发者设置中创建开放 API Token。
2. 不要把 Token 写进前端、Electron 安装包或仓库；只在开发者构建机设置环境变量：

```powershell
$env:AFDIAN_USER_ID = '8813900a1cd511ea87be52540025c377'
$env:AFDIAN_TOKEN = '<你的开放 API Token>'
npm run sync:sponsors
```

`npm run build` 会以可选模式执行同一同步：设置了 Token 就更新名单，未设置则保留上一次生成结果，不会导致普通构建失败。

> 公开创作者页面只能用于展示方案，不能安全地替代开放 API。赞助者明细涉及隐私且开放 API Token 属于服务端密钥，因此本项目采用“开发者构建时生成静态名单”的方式，不把密钥下发给用户。
