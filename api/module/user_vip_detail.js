// 联合会员查询(酷狗会员中心 kugouvip)。
// busi_type 缺省 concept = 概念版(本 App 走 lite 平台,默认读的就是概念版会员);
// 允许调用方传 busi_type 覆盖 → 便于排查/读取其它业务线会员(如标准版酷狗音乐的 dvip/qvip),
// 默认值不变,不影响既有前端调用。
module.exports = (params, useAxios) => {
  return useAxios({
    baseURL: 'https://kugouvip.kugou.com',
    url: '/v1/get_union_vip',
    method: 'GET',
    params: { busi_type: params?.busi_type || 'concept' },
    encryptType: 'android',
    cookie: params?.cookie || {},
  });
};
