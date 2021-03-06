import { Router } from 'express';
import lcd from './lcd';
import iscnDev from './iscn-dev';

const router = Router();
router.use('/lcd', lcd);
router.use('/iscn-dev', iscnDev);

export default router;
