# 随仓库提供的数据清单

本发布版保留运行或执行 `npm run build:data` 实际需要的规范化规则与 ICD 文件。下表只说明数据包和仓库位置，不构成对再分发权利的法律判断。

| 内容 | 数据包或路径 | 说明 |
|---|---|---|
| CHS-DRG 2.0 公共规则 | `src/data/drg-common/chs-2.0/` | MDC/ADRG、CC/MCC/CCE、无效编码的输入及生成数据 |
| CHS-DRG 3.0 公共规则 | `src/data/drg-common/chs-3.0/` | MDC/ADRG、CC/MCC/CCE、无效编码的输入及生成数据 |
| CHS-DRG 2.0 版本 | `src/data/versions/chs-drg-2.0/` | DRG 规则和名称 |
| CHS-DRG 3.0 版本 | `src/data/versions/chs-drg-3.0/` | DRG 规则和名称 |
| 上海 DRG 2.0 版本 | `src/data/versions/shanghai-drg-2.0/` | DRG 规则、补丁和名称；发布版 DRG.dat 不包含权重列 |
| 国临 ICD | `src/data/icd-datasets/clinical/gl-2022/` | 编码、名称和生成的检索数据 |
| 医保 ICD | `src/data/icd-datasets/insurance/yb-2.0/` | 编码、名称、灰码和生成的检索数据 |
| ICD 转换映射 | `src/data/crosswalks/gl-2022__yb-2.0/` | 显式映射输入、扩展映射和运行时 JSON |

参考 PDF 和 Excel 不随发布版提供。CHS-DRG 2.0 的规范化规则来源可追溯到国家医保局 2024 年 7 月 23 日发布的文件：

- [国家医疗保障局发布页面](https://www.nhsa.gov.cn/art/2024/7/23/art_53_13314.html)
- [原始 PDF 下载地址](https://www.nhsa.gov.cn/module/download/downfile.jsp?classid=0&filename=4ebd4dedb12d464aa47be434c478f0c4.pdf)

发布派生仓库前，应使用 `DATA_PROVENANCE_TEMPLATE.json` 为每个数据包补齐来源和权利记录。
