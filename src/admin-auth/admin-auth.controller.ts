import { Body, Controller, Post } from '@nestjs/common';
import { AdminAuthService } from './admin-auth.service.js';
import { LoginDto } from './dto/login.dto.js';

@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly service: AdminAuthService) {}

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.service.login(dto.email, dto.password);
  }
}
