import { describe, expect, it } from 'vitest'
import { plainPreview, compactNumber, duration, percent } from './format'

describe('plainPreview', () => {
  it('去掉标题、表格、代码块这些一行放不下的东西', () => {
    // 这是真实踩到的样子：折叠行上出现
    // 「## 目录概览 两列表格： | 项目 | 值 | | --- | --- |」
    const input = [
      "Both commands ran successfully. Here's the summary:",
      '',
      '## 目录概览',
      '',
      '| 项目 | 值 |',
      '| --- | --- |',
      '| 目录条目总数 | 14 |',
      '',
      '```bash',
      'ls -la',
      '```',
    ].join('\n')

    const got = plainPreview(input)
    expect(got).toBe("Both commands ran successfully. Here's the summary: 目录概览")
    expect(got).not.toContain('|')
    expect(got).not.toContain('#')
    expect(got).not.toContain('```')
  })

  it('剥掉强调标记但保留文字', () => {
    expect(plainPreview('**粗体** 和 *斜体* 和 `代码` 和 ~~删除~~')).toBe('粗体 和 斜体 和 代码 和 删除')
  })

  it('链接保留文字丢掉 URL', () => {
    expect(plainPreview('见 [文档](https://example.com/a(b)) 说明')).toBe('见 文档 说明')
  })

  it('列表标记去掉，内容连成一行', () => {
    expect(plainPreview('- 一\n- 二\n1. 三')).toBe('一 二 三')
  })

  it('纯文本原样返回', () => {
    expect(plainPreview("I'll take a look at the current directory.")).toBe(
      "I'll take a look at the current directory.",
    )
  })
})

describe('format 基础函数', () => {
  it('compactNumber', () => {
    expect(compactNumber(999)).toBe('999')
    expect(compactNumber(1234)).toBe('1.2k')
    expect(compactNumber(45678)).toBe('46k')
  })

  it('duration', () => {
    expect(duration(52)).toBe('52ms')
    expect(duration(1500)).toBe('1.5s')
    expect(duration(undefined)).toBe('')
    // 0 要显示成 0ms 而不是空串——「耗时 0」和「没有耗时数据」是两回事。
    expect(duration(0)).toBe('0ms')
  })

  it('percent 钳到 0..100，分母为 0 时返回 0 而不是 NaN', () => {
    expect(percent(50, 100)).toBe(50)
    expect(percent(150, 100)).toBe(100)
    expect(percent(5, 0)).toBe(0)
  })
})
