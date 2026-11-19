import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
export declare const name: string
export declare const inject: string[]
export declare const Config: ReturnType<typeof z.object>
export declare function apply(ctx: Context, config?: Record<string, unknown>): void
