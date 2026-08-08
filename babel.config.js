module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // Must stay last. Reanimated's worklet transform lives in react-native-worklets
    // as of SDK 54+; the old 'react-native-reanimated/plugin' entry is gone.
    plugins: ['react-native-worklets/plugin'],
  };
};
