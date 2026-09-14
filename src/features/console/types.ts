/** 从领域层再导出，让 features 层的组件不必直接 import store 内部路径。 */
export type { TurnView, StepView } from '@/store/liveThread/state'
export { TURN_FAILURE_CODES, type TurnFailureCode } from '@/types/contract'
