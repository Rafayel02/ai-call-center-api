import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDemoRequestDto } from './dto/create-demo-request.dto';

@Injectable()
export class DemoRequestsService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateDemoRequestDto) {
    return this.prisma.demoRequest.create({
      data: dto,
      select: { id: true },
    });
  }

  list() {
    return this.prisma.demoRequest.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        name: true,
        businessName: true,
        contact: true,
        industry: true,
        role: true,
        callVolume: true,
        needs: true,
        createdAt: true,
      },
    });
  }
}
