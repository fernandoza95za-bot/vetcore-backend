import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

export interface AdminJwtPayload {
  sub: number;
  email: string;
}

@Injectable()
export class JwtAdminGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { admin?: AdminJwtPayload }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Falta el token de administrador');
    }
    try {
      const payload = await this.jwt.verifyAsync<AdminJwtPayload>(header.slice('Bearer '.length));
      req.admin = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Sesión de administrador inválida o vencida');
    }
  }
}
