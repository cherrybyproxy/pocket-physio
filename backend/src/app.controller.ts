import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  getRoot(): { status: string; service: string; health: string } {
    return {
      status: 'ok',
      service: 'Pocket Physio API',
      health: '/health',
    };
  }

  @Get('health')
  getHealth(): { status: string; timestamp: string } {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}
