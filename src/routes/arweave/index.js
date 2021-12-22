import BigNumber from 'bignumber.js';
import { Router } from 'express';
import multer from 'multer';
import { estimateARPrices, convertARPricesToLIKE, uploadFilesToArweave } from '../../util/arweave';
import { getIPFSHash, uploadFilesToIPFS } from '../../util/ipfs';
import { queryLIKETransactionInfo } from '../../util/cosmos/tx';

const { ARWEAVE_LIKE_TARGET_ADDRESS } = require('../../../config/config');

const maxSize = 100 * 1024 * 1024; // 100 MB

const router = Router();

function checkFileValid(req, res, next) {
  if (!(req.files && req.files.length)) {
    res.status(400).send('MISSING_FILE');
    return;
  }
  const { files } = req;
  if (files.length > 1 && !files.find(f => f.fieldname === 'index.html')) {
    res.status(400).send('MISSING_INDEX_FILE');
    return;
  }
  next();
}

function convertMulterFiles(files) {
  return files.map((f) => {
    const { mimetype, buffer } = f;
    return {
      key: f.fieldname,
      mimetype,
      buffer,
    };
  });
}

router.post(
  '/estimate',
  multer({ limits: { fileSize: maxSize } }).any(),
  checkFileValid,
  async (req, res, next) => {
    try {
      const { files } = req;
      const arFiles = convertMulterFiles(files);
      const [
        ipfsHash,
        prices,
      ] = await Promise.all([
        getIPFSHash(arFiles),
        estimateARPrices(arFiles),
      ]);
      const pricesWithLIKE = await convertARPricesToLIKE(prices);
      res.json({
        ...pricesWithLIKE,
        ipfsHash,
        memo: JSON.stringify({ ipfs: ipfsHash }),
        address: ARWEAVE_LIKE_TARGET_ADDRESS,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post('/upload',
  multer({ limits: { fileSize: maxSize } }).any(),
  checkFileValid,
  async (req, res, next) => {
    try {
      const { files } = req;
      const arFiles = convertMulterFiles(files);
      const [
        ipfsHash,
        prices,
      ] = await Promise.all([
        getIPFSHash(arFiles),
        estimateARPrices(arFiles),
      ]);
      const { arweaveId: existingArweaveId } = prices;

      // shortcut for existing file without checking tx
      if (existingArweaveId) {
        res.json({
          arweaveId: existingArweaveId,
          ipfsHash,
        });
        return;
      }

      const { txHash } = req.query;
      if (!txHash) {
        res.status(400).send('MISSING_TX_HASH');
        return;
      }
      const tx = await queryLIKETransactionInfo(txHash, ARWEAVE_LIKE_TARGET_ADDRESS);
      if (!tx || !tx.amount) {
        res.status(400).send('TX_NOT_FOUND');
        return;
      }
      const { memo, amount } = tx;
      let memoIPFS = '';
      try {
        ({ ipfs: memoIPFS } = JSON.parse(memo));
      } catch (err) {
      // ignore non-JSON memo
      }
      if (!memoIPFS || memoIPFS !== ipfsHash) {
        res.status(400).send('TX_MEMO_NOT_MATCH');
        return;
      }
      const { LIKE } = await convertARPricesToLIKE(prices, { margin: 0.03 });
      const txAmount = new BigNumber(amount.amount).shiftedBy(-9);
      if (txAmount.lt(LIKE)) {
        res.status(400).send('TX_AMOUNT_NOT_ENOUGH');
        return;
      }
      const [{ arweaveId, list }] = await Promise.all([
        uploadFilesToArweave(arFiles),
        uploadFilesToIPFS(arFiles),
      ]);
      res.json({ arweaveId, ipfsHash, list });
    } catch (error) {
      next(error);
    }
  });

export default router;