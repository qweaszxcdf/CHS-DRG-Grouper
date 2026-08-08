# CHS-DRG Grouper

面向中文用户的开源 DRG 分组器。项目以 CHS-DRG 为核心，同时支持上海 DRG 等区域版本，提供浏览器端分组、批量处理、编码检索、规则查看和本地 HTTP API。

> [!IMPORTANT]
> 本项目是独立实现，不是国家医保局、地方医保部门或其他机构提供的官方分组服务。将结果用于编码、付费、审核或结算前，请依据适用版本的正式文件复核规则、编码和分组结果。

## 支持范围

| 分组版本 | 公共规则包 | 国临 ICD | 医保 ICD | 默认启用 |
|---|---|---|---|---|
| CHS-DRG 2.0 | `chs-2.0` | `gl-2022` | `yb-2.0` |  |
| CHS-DRG 3.0 | `chs-3.0` | `gl-2022` | `yb-2.0` |  |
| 上海 DRG 2.0 | `chs-2.0` | `gl-2022` | `yb-2.0` | ✓ |

版本 ID 分别为 `chs-drg-2.0`、`chs-drg-3.0` 和 `shanghai-drg-2.0`。版本通过各自的 `config.json` 明确引用公共规则包及 ICD 数据包。

## 主要功能

- 纯 JavaScript 分组引擎，可在浏览器和 Node.js 中运行
- 追踪 MDC → ADRG → DRG 的完整判定过程
- 支持单病例分组和 CSV/XLSX 批量处理
- 支持国临码、医保码检索及国临码到医保码转换
- 支持 MDC、ADRG 和 DRG 规则查看
- 规则、ICD、映射和版本注册表均可从规范化输入重新生成
- 前端在浏览器本地计算，不会主动上传病案数据
- Full 和 Lite 两种前端构建

## 快速开始

环境要求：

- Node.js 22.12 或更高版本
- npm 11，或与 `package-lock.json` 兼容的 npm 版本

安装依赖并启动开发服务器：

```bash
npm ci
npm run dev
```

Vite 会输出访问地址，通常为 `http://localhost:5173`。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 启动开发服务器 |
| `npm run build` | 使用已生成数据构建 Full 版本到 `dist/` |
| `npm run build:lite` | 构建 Lite 版本到 `dist-lite/` |
| `npm run build:data` | 重新生成全部规则、ICD、映射和版本注册数据 |
| `npm run build:release` | 重建数据后依次构建 Full 和 Lite 版本 |
| `npm run serve-api` | 启动本地 HTTP API |
| `npm run lint` | 执行 ESLint |
| `npm test` | 执行分组回归测试 |
| `npm run check` | 执行 lint、测试、数据重建和两种生产构建 |

## Full 与 Lite

Full 版本包含：

- 单病例分组
- 批量处理
- 编码检索
- MDC 规则树
- 完整分组轨迹及扩展功能

Lite 版本通过 `VITE_LITE=true` 构建，主要保留单病例分组界面，并在构建阶段排除批量、检索和规则树页面。

## 网页端使用

1. 在顶部选择 DRG 版本。
2. 根据输入编码类型选择是否使用医保码。
3. 按顺序填写诊断和手术编码；第一项分别作为主诊断和主手术。
4. 根据需要填写性别、年龄、日龄、出生体重、离院方式、新技术和多部位手术等信息。
5. 执行分组并查看 DRG 结果及 `matchTrace` 判定轨迹。

批量处理支持 CSV 和 Excel。上传文件后，应先确认字段映射、编码分隔符和患者信息列，再开始分组。请勿上传或提交带有可识别个人身份的信息。

## HTTP API

启动服务：

```bash
npm run serve-api
```

服务默认仅监听 `127.0.0.1:3000`。只有在可信容器或部署环境中，才应显式设置 `HOST=0.0.0.0`。

可用接口：

- `GET /`：服务信息和可用版本
- `GET /versions`：列出规则版本
- `POST /group`：对一条病例记录执行分组

示例：

```bash
curl -X POST 'http://127.0.0.1:3000/group?version=chs-drg-3.0' \
  -H 'Content-Type: application/json' \
  -d '{"diagnoses":["K80.101","I50.900"],"procedures":["51.2300"],"patientInfo":{"gender":1,"age":45,"multiSite":false}}'
```

该示例在当前 CHS-DRG 3.0 数据中得到：

```text
MDC  = MDCH
ADRG = HC4
DRG  = HC43
```

请求说明：

- `diagnoses`：诊断编码数组，第一项为主诊断
- `procedures`：手术或操作编码数组，第一项为主手术
- `patientInfo`：患者分组条件；未使用的字段可以省略
- `version`：可放在查询参数或请求体中；省略时使用默认版本
- `source=GL`：先按所选版本将国临码转换为医保码，再执行分组

## 数据与构建链

```text
src/data/**/raw
        │
        ├── scripts/build_rules_json.cjs
        ├── scripts/build_icd_mappings.cjs
        ▼
src/data/**/generated
        │
        └── scripts/generate_version_data.cjs
                ▼
src/services/generated
        │
        ├── 浏览器界面
        └── Node.js HTTP API
```

目录约定：

```text
src/data/
├── drg-common/<公共规则包>/{raw,generated}
├── versions/<分组版本>/{raw,generated}
├── icd-datasets/{clinical,insurance}/<数据包>/{raw,generated}
└── crosswalks/<国临包>__<医保包>/{raw,generated}
```

- `raw/` 是数据构建实际读取的规范化输入。
- `generated/` 是脚本生成、运行时实际加载的数据。
- `src/services/generated/` 是按版本生成的注册表和动态加载模块。
- 共享分组行为应放在版本引用的 DRG 公共规则包配置中，不应在各版本重复维护。

## 修改规则或 ICD 数据

1. 确认有权使用、转换和分发输入数据及其生成结果。
2. 使用 [DATA_PROVENANCE_TEMPLATE.json](DATA_PROVENANCE_TEMPLATE.json) 记录来源、版本、文件摘要和授权信息。
3. 修改对应数据包的 `raw/` 输入，不要直接修改生成文件。
4. 运行 `npm run build:data`。
5. 检查所有生成差异。
6. 为分组行为变化增加确定性的回归用例。
7. 运行 `npm run check`。

没有明确来源和再分发依据的第三方数据，不应提交到公开仓库。

## 项目结构

```text
├── src/                         # React 界面和分组引擎
│   ├── data/                    # 规则与 ICD 数据包
│   ├── services/                # 分组、检索、转换和版本加载
│   ├── tabs/                    # 单病例、批量、检索和规则树页面
│   └── workers/                 # 浏览器批量解析 Worker
├── scripts/                     # 数据构建和本地 API
├── tests/                       # 分组回归测试
├── public/                      # 静态资源
└── .github/                     # CI 与协作模板
```

## 数据、隐私和许可证

- 不得提交真实病案、生产导出、身份信息、凭据或访问令牌。
- 仓库只保留运行和可复现构建需要的规则与 ICD 文件，不包含参考 PDF、Excel 和重复知识库。
- 项目自行编写的软件采用 Apache-2.0。
- 官方或第三方编码、名称、规则、映射及衍生数据仍受各自权利人的条款约束，不因本项目许可证而重新授权。

详细信息：

- [数据政策](DATA_POLICY.md)
- [数据清单](DATA_SOURCES.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)
- [参与贡献](CONTRIBUTING.md)
- [安全政策](SECURITY.md)
- [LICENSE](LICENSE)
- [NOTICE](NOTICE)

## 静态部署

```bash
npm run build
```

将 `dist/` 内容发布到任意静态 Web 服务器即可。仓库不包含特定云平台的部署配置。
