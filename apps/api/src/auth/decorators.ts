import { createParamDecorator, type ExecutionContext, SetMetadata } from "@nestjs/common";
import type { Request } from "express";
import type { AuthUser } from "./auth.service";
import type { Permission } from "./permissions";

export const IS_PUBLIC = "auth:public";
export const REQUIRED_PERMISSION = "auth:permission";

/** The route needs no sign-in. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** The signed-in user needs a role in the route's `:storeId` that grants this. */
export const RequirePermission = (permission: Permission) => SetMetadata(REQUIRED_PERMISSION, permission);

export type AuthedRequest = Request & { auth?: AuthUser };

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const auth = ctx.switchToHttp().getRequest<AuthedRequest>().auth;
  if (!auth) throw new Error("CurrentUser used on a public route");
  return auth;
});
