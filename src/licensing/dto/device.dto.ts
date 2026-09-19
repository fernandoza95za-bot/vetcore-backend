import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class ActivateDto {
  @IsString()
  @MinLength(1)
  licenseKey!: string;

  @IsString()
  @MinLength(8)
  hwid!: string;

  @IsString()
  @MinLength(1)
  deviceName!: string;

  @IsOptional()
  @IsIn(['principal', 'secundario'])
  deviceRole?: 'principal' | 'secundario';

  @IsOptional()
  @IsString()
  branchLabel?: string;
}

export class HeartbeatDto {
  @IsString()
  @MinLength(1)
  licenseKey!: string;

  @IsString()
  @MinLength(8)
  hwid!: string;
}

export class BranchBundleDto {
  @IsString()
  @MinLength(1)
  licenseKey!: string;

  @IsString()
  @MinLength(8)
  hwid!: string;
}

/**
 * Registro silencioso de prueba: no pide ninguna clave de licencia, porque
 * todavía no existe una — el backend crea la clínica (o encuentra la que ya
 * existe, por el correo/teléfono de contacto) y la licencia de prueba en el
 * mismo paso. Deliberadamente no tiene ningún campo que mencione
 * "licencia" — eso es justo lo que este endpoint evita en la app.
 */
export class RegisterTrialDto {
  @IsString()
  @MinLength(1)
  clinicName!: string;

  @IsOptional()
  @IsString()
  contactName?: string;

  @IsOptional()
  @IsString()
  contactEmail?: string;

  @IsOptional()
  @IsString()
  contactPhone?: string;

  @IsString()
  @MinLength(8)
  hwid!: string;

  @IsString()
  @MinLength(1)
  deviceName!: string;
}
