import { Body, Controller, Get, HttpCode, Inject, Post } from "@nestjs/common";
import { AuthService, type AuthUser, type LoginRequest } from "./auth.service";
import { CurrentUser, Public } from "./decorators";

@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post("login")
  @HttpCode(200)
  login(@Body() body: LoginRequest) {
    return this.auth.login(body);
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@CurrentUser() user: AuthUser): Promise<void> {
    await this.auth.logout(user);
  }

  @Get("me")
  async me(@CurrentUser() user: AuthUser) {
    return {
      user: { id: user.userId, email: user.email, name: user.name },
      stores: await this.auth.storeAccess(user.storeRoles),
    };
  }
}
