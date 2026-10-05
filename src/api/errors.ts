/**
 * 后端错误码。取自 internal/transport/http/middleware.go 的 writeDomainError
 * 与 threads.go 里的直接调用，是一个封闭集合。
 *
 * 前端**只**依据 code 分支，绝不解析 message —— 后端注释明确说了错误文本
 * 随时会为排查方便而改写，原因码不会。这条约定和后端用 sentinel error
 * 而非字符串匹配是同一个道理。
 */
export type ApiErrorCode =
  | 'bad_request'
  | 'invalid_workspace'
  | 'thread_not_found'
  | 'endpoint_not_found'
  | 'turn_in_progress'
  | 'provider_error'
  | 'internal'
  | 'network' // 前端自己造的：请求根本没发出去或连接断了

/** 面向用户的中文文案。未知 code 落到 fallback，不裸奔英文原文。 */
const MESSAGES: Record<ApiErrorCode, string> = {
  bad_request: '请求格式有误',
  invalid_workspace: '工作目录无效',
  thread_not_found: '会话不存在或已被删除',
  endpoint_not_found: '接口不存在；请重启后端服务以加载最新代码',
  turn_in_progress: '该会话已有任务在执行',
  provider_error: '模型服务异常，请稍后重试',
  internal: '服务内部错误',
  network: '无法连接到后端服务',
}

export class ApiError extends Error {
  readonly code: ApiErrorCode
  readonly status: number
  /** 后端原始 message，只用于开发排查和日志，不直接展示给用户。 */
  readonly detail: string

  constructor(code: string, status: number, detail: string) {
    const known = (code in MESSAGES ? code : 'internal') as ApiErrorCode
    super(MESSAGES[known])
    this.name = 'ApiError'
    this.code = known
    this.status = status
    this.detail = detail
  }

  /**
   * 该不该弹 Toast。
   *
   * turn_in_progress 不弹：它是并发提交时的正常拒绝，而 UI 在 status=running
   * 时本来就禁用了提交按钮。真出现这个错说明两个标签页开着同一个会话，
   * 此时界面状态会通过 SSE 自行纠正，再弹个红框只会让人困惑。
   */
  get shouldToast(): boolean {
    return this.code !== 'turn_in_progress'
  }

  /**
   * 面向用户的详细说明，拿不到就退回通用文案。
   *
   * 这里用后端原始 message 并不违反「绝不解析 message」那条规矩 ——
   * 那条规矩管的是**分支判断**（分支只能依据 code，因为文本随时会改），
   * 不是**展示**。对字段级校验错误来说，「/etc 不在 /Users/... 之内」
   * 比「工作目录无效」有用得多：前者告诉用户怎么改，后者只是重复了一遍他已经知道的事。
   */
  get detailedMessage(): string {
    return this.detail.trim() || this.message
  }

  /** 重试有没有意义。用来决定 Query 的 retry 策略和 Toast 上要不要放重试按钮。 */
  get retryable(): boolean {
    return this.code === 'provider_error' || this.code === 'internal' || this.code === 'network'
  }
}
