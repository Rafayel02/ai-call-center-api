import { Module } from '@nestjs/common';
import { BootstrapAdminService } from './bootstrap-admin.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, BootstrapAdminService],
  exports: [UsersService],
})
export class UsersModule {}
