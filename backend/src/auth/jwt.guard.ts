// reusable jwt auth guard. apply to any controller or route that requires authentication.

import { AuthGuard } from '@nestjs/passport';

export class JwtGuard extends AuthGuard('jwt') {}
