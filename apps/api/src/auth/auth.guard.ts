import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ForbiddenError, NotFoundError } from "../common/errors";
import { AuthService } from "./auth.service";
import { type AuthedRequest, IS_PUBLIC, REQUIRED_PERMISSION } from "./decorators";
import { type Permission, rolesGrant } from "./permissions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs on every route. Routes are private unless marked @Public. A route
 * under `/stores/:storeId` must declare a permission, and the user must hold
 * a role in that store granting it; anything undeclared is refused.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    request.auth = await this.auth.authenticate(token);

    const permission = this.reflector.getAllAndOverride<Permission | undefined>(REQUIRED_PERMISSION, targets);
    const storeId: unknown = request.params.storeId;
    if (storeId === undefined) {
      if (permission) throw new Error(`Route requires ${permission} but has no :storeId`);
      return true;
    }
    if (!permission) throw new ForbiddenError("This action is not available");

    const roles = typeof storeId === "string" && UUID.test(storeId) ? request.auth.storeRoles.get(storeId) : undefined;
    // No role in the store looks the same as a store that does not exist.
    if (!roles) throw new NotFoundError("Store not found");
    if (!rolesGrant(roles, permission)) {
      throw new ForbiddenError("Your role does not allow this action", { permission });
    }
    return true;
  }
}
