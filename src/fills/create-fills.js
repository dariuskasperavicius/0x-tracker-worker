const _ = require('lodash');
const ms = require('ms');

const { checkTokenResolved } = require('../tokens/token-cache');
const { getModel } = require('../model');
const { JOB, QUEUE } = require('../constants');
const { publishJob } = require('../queues');
const applyAttributionsToFill = require('./apply-attributions-to-fill');
const convertProtocolFee = require('../fills/convert-protocol-fee');
const indexFill = require('../index/index-fill');
const indexTradedTokens = require('../index/index-traded-tokens');
const hasProtocolFee = require('./has-protocol-fee');
const hasRelayerFees = require('./has-relayer-fees');
const convertRelayerFees = require('./convert-relayer-fees');
const getAppAttributionsForFill = require('./get-app-attributions-for-fill');

const createFills = async (fills, { session }) => {
  const attributedFills = fills.map(fill => applyAttributionsToFill(fill));
  const fillsWithTokenStatus = attributedFills.map(fill => ({
    ...fill,
    assets: fill.assets.map(asset => ({
      ...asset,
      tokenResolved: checkTokenResolved(asset.tokenAddress),
    })),
  }));

  const Fill = getModel('Fill');
  const newFills = await Fill.create(fillsWithTokenStatus, { session });

  await Fill.populate(newFills, [
    { path: 'relayer' },
    { path: 'assets.token' },
    { path: 'fees.token' },
  ]);

  /* A bug in Mongoose prevents assets.token from being set even though the
   * related tokens are fetched properly. We therefore have to set the value manually.
   */
  const populatedFills = newFills.map(newFill => {
    const assetTokens = _.compact(newFill.populated('assets.token'));
    const feeTokens = _.compact(newFill.populated('fees.token'));
    const populatedFill = {
      ...newFill.toObject(),
      assets: newFill.assets.map(asset => {
        const token = assetTokens.find(t => t.address === asset.tokenAddress);

        return { ...asset.toObject(), token };
      }),
      fees: newFill.fees.map(fee => {
        const token = feeTokens.find(t => t.address === fee.tokenAddress);

        return { ...fee.toObject(), token };
      }),
    };

    return populatedFill;
  });

  await Promise.all(
    populatedFills.map(async fill => {
      const fillId = fill._id.toString();

      await indexFill(fillId, ms('30 seconds'));
      await indexTradedTokens(fill);

      if (hasProtocolFee(fill)) {
        await convertProtocolFee(fill, ms('30 seconds'));
      }

      if (hasRelayerFees(fill)) {
        await convertRelayerFees(fillId, ms('30 seconds'));
      }

      if (fill.apps.length > 0) {
        await publishJob(QUEUE.INDEXING, JOB.INDEX_APP_FILL_ATTRIBUTONS, {
          attributions: getAppAttributionsForFill(fill),
          date: fill.date,
          fillId,
        });
      }
    }),
  );
};

module.exports = createFills;
