import test from 'ava';
import {
  testingUser1,
  testingUser2,
  testingUser1Locale,
  testingUser1CreatorPitch,
} from './data';
import axiosist from './axiosist';

const { jwtSign } = require('./jwt');

test('USER: Get user preferences. Case: success', async (t) => {
  const user = testingUser1;
  const token = jwtSign({ user });
  const res = await axiosist.get('/api/users/preferences', {
    headers: {
      Accept: 'application/json',
      Cookie: `likecoin_auth=${token}`,
    },
  });
  t.is(res.status, 200);
  t.is(res.data.locale, testingUser1Locale);
  t.is(res.data.creatorPitch, testingUser1CreatorPitch);
});

test('USER: Set user preferences (Locale). Case: success', async (t) => {
  const user = testingUser1;
  const token = jwtSign({ user });
  const res = await axiosist.post('/api/users/preferences', { locale: 'zh' }, {
    headers: {
      Accept: 'application/json',
      Cookie: `likecoin_auth=${token}`,
    },
  });
  t.is(res.status, 200);
});

test('USER: Set user preferences (Locale). Case: failed', async (t) => {
  const user = testingUser1;
  const token = jwtSign({ user });
  const res = await axiosist.post('/api/users/preferences', { locale: 'xy' }, {
    headers: {
      Accept: 'application/json',
      Cookie: `likecoin_auth=${token}`,
    },
  });
  t.is(res.status, 400);
});

test('USER: Set user preferences (Creator pitch). Case: success', async (t) => {
  const creatorPitch = 'Oh, Hi Mark!';
  const user = testingUser2;
  const token = jwtSign({ user });
  const config = {
    headers: {
      Accept: 'application/json',
      Cookie: `likecoin_auth=${token}`,
    },
  };
  let res = await axiosist.post('/api/users/preferences', { creatorPitch }, config);
  t.is(res.status, 200);
  res = await axiosist.get('/api/users/preferences', config);
  t.is(res.data.creatorPitch, creatorPitch);
});

test('USER: Update user preferences (Creator pitch). Case: success', async (t) => {
  const user = testingUser1;
  const token = jwtSign({ user });
  const config = {
    headers: {
      Accept: 'application/json',
      Cookie: `likecoin_auth=${token}`,
    },
  };
  let res = await axiosist.post('/api/users/preferences', {
    creatorPitch: 'Hello world',
  }, config);
  t.is(res.status, 200);
  res = await axiosist.get('/api/users/preferences', config);
  t.is(res.data.creatorPitch, 'Hello world');

  res = await axiosist.post('/api/users/preferences', {
    creatorPitch:
      '0123456789零一二三四五六七八九0123456789零一二三四五六七八九0123456789零一二三四五六七八九0123456789零一二三四五六七八九0123456789零一二三四五六七八九0123456789零一二三四五六七八九',
  }, config);
  t.is(res.status, 200);
  res = await axiosist.get('/api/users/preferences', config);
  t.is(
    res.data.creatorPitch,
    '0123456789零一二三四五六七八九0123456789零一二三四五六七八九0123456789零一二三四五六七八九0123456789零一二三四五六七八九0123456789零一二三四五六七八九',
  );

  res = await axiosist.post('/api/users/preferences', { creatorPitch: '' }, config);
  t.is(res.status, 200);
  res = await axiosist.get('/api/users/preferences', config);
  t.is(res.data.creatorPitch, '');
});

test('USER: Set user preferences (Creator pitch). Case: failed', async (t) => {
  const user = testingUser1;
  const token = jwtSign({ user });
  const res = await axiosist.post('/api/users/preferences', {
    creatorPitch: 123,
  }, {
    headers: {
      Accept: 'application/json',
      Cookie: `likecoin_auth=${token}`,
    },
  });
  t.is(res.status, 400);
});