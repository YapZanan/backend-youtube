import type { RequestIdVariables } from "hono/request-id";
import { Hono } from "hono";

export type App = {
    Bindings: Env,
    Variables: RequestIdVariables
}

export type AppOpenAPi = Hono<App>;