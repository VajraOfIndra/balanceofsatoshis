const asyncAuto = require('async/auto');
const asyncMap = require('async/map');
const {getNode} = require('ln-service');
const {getPayments} = require('ln-service');
const moment = require('moment');
const {returnResult} = require('asyncjs-util');

const feesForSegment = require('./fees_for_segment');
const {sortBy} = require('./../arrays');

const daysPerWeek = 7;
const {floor} = Math;
const heading = [['Node', 'Public Key', 'Fees Paid', 'Forwarded']];
const hoursPerDay = 24;
const {keys} = Object;
const minChartDays = 4;
const maxChartDays = 90;
const mtokensAsBigUnit = n => (Number(n / BigInt(1e3)) / 1e8).toFixed(8);
const tokensAsBigUnit = tokens => (tokens / 1e8).toFixed(8);

/** Get routing fees paid

  {
    days: <Fees Earned Over Days Count Number>
    [is_most_fees_table]: <Is Most Fees Table Bool>
    [is_most_forwarded_table]: <Is Most Forwarded Bool>
    lnd: <Authenticated LND gRPC API Object>
  }

  @returns via cbk or Promise
  {
    data: [<Earned Fee Tokens Number>]
    description: <Chart Description String>
    title: <Chart Title String>
  }
*/
module.exports = (args, cbk) => {
  return new Promise((resolve, reject) => {
    return asyncAuto({
      // Check arguments
      validate: cbk => {
        if (!args.days) {
          return cbk([400, 'ExpectedNumberOfDaysToGetFeesOverForChart']);
        }

        if (!args.lnd) {
          return cbk([400, 'ExpectedLndToGetFeesChart']);
        }

        return cbk();
      },

      // Get payments
      getPayments: ['validate', ({}, cbk) => {
        return getPayments({lnd: args.lnd}, cbk);
      }],

      // Segment measure
      measure: ['validate', ({}, cbk) => {
        if (args.days > maxChartDays) {
          return cbk(null, 'week');
        } else if (args.days < minChartDays) {
          return cbk(null, 'hour');
        } else {
          return cbk(null, 'day');
        }
      }],

      // Start date for payments
      start: ['validate', ({}, cbk) => {
        return cbk(null, moment().subtract(args.days, 'days'));
      }],

      // Filter the payments
      forwards: ['getPayments', 'start', ({getPayments, start}, cbk) => {
        const payments = getPayments.payments.filter(n => {
          return n.created_at > start.toISOString();
        });

        return cbk(null, payments);
      }],

      // Fees paid to specific forwarding peers
      rows: ['forwards', ({forwards}, cbk) => {
        if (!args.is_most_forwarded_table && !args.is_most_fees_table) {
          return cbk();
        }

        const fees = forwards.reduce((sum, {attempts}) => {
          attempts.filter(n => !!n.is_confirmed).forEach(({route}) => {
            return route.hops.slice().reverse().forEach((hop, i) => {
              if (!i) {
                return;
              }

              const key = hop.public_key;

              const current = sum[key] || BigInt(Number());

              sum[key] = current + BigInt(hop.fee_mtokens);

              return;
            });
          });

          return sum;
        },
        {});

        const forwarded = forwards.reduce((sum, {attempts}) => {
          attempts.filter(n => !!n.is_confirmed).forEach(({route}) => {
            return route.hops.slice().reverse().forEach((hop, i) => {
              if (!i) {
                return;
              }

              const key = hop.public_key;

              const current = sum[key] || BigInt(Number());

              sum[key] = current + BigInt(hop.forward_mtokens);

              return;
            });
          });

          return sum;
        },
        {});

        return asyncMap(keys(fees), (key, cbk) => {
          return getNode({
            is_omitting_channels: true,
            lnd: args.lnd,
            public_key: key,
          },
          (err, res) => {
            return cbk(null, {
              alias: (res || {}).alias,
              fees_paid: fees[key],
              forwarded: forwarded[key] || BigInt(Number()),
              public_key: key,
            });
          });
        },
        (err, array) => {
          if (!!err) {
            return cbk(err);
          }

          const sort = !!args.is_most_fees_table ? 'fees_paid' : 'forwarded';

          const rows = sortBy({array, attribute: sort}).sorted.map(n => {
            return [
              n.alias,
              n.public_key,
              mtokensAsBigUnit(n.fees_paid),
              mtokensAsBigUnit(n.forwarded),
            ];
          });

          return cbk(null, [].concat(heading).concat(rows));
        });
      }],

      // Total number of segments
      segments: ['measure', ({measure}, cbk) => {
        switch (measure) {
        case 'hour':
          return cbk(null, hoursPerDay * args.days);

        case 'week':
          return cbk(null, floor(args.days / daysPerWeek));

        default:
          return cbk(null, args.days);
        }
      }],

      // Total paid
      total: ['forwards', ({forwards}, cbk) => {
        const paid = forwards.reduce((sum, {fee}) => sum + fee, Number());

        return cbk(null, paid);
      }],

      // Payments activity aggregated
      sum: [
        'forwards',
        'measure',
        'segments',
        ({forwards, measure, segments}, cbk) =>
      {
        return cbk(null, feesForSegment({forwards, measure, segments}));
      }],

      // Summary description of the fees paid
      description: [
        'forwards',
        'measure',
        'start',
        'sum',
        'total',
        ({forwards, measure, start, sum, total}, cbk) =>
      {
        const duration = `Fees paid in ${sum.fees.length} ${measure}s`;
        const paid = tokensAsBigUnit(total);
        const since = `since ${start.calendar().toLowerCase()}`;

        return cbk(null, `${duration} ${since}. Total: ${paid}`);
      }],

      // Fees paid
      data: ['description', 'rows', 'sum', ({description, rows, sum}, cbk) => {
        const data = sum.fees;
        const title = 'Routing fees paid';

        return cbk(null, {data, description, rows, title});
      }],
    },
    returnResult({reject, resolve, of: 'data'}, cbk));
  });
};
