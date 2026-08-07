import { ConfigProvider, Flex, theme } from 'antd';

import Window from './Window';

const SERVER_URL = 'ws://localhost:3001/ws';

function App() {
  const { darkAlgorithm } = theme;

  return (
    <ConfigProvider theme={{ algorithm: darkAlgorithm }}>
      <div>
        <h1>Todo Demo</h1>
        <Flex wrap gap="small">
          <Window name="Client A" serverUrl={SERVER_URL} />
          <Window name="Client B" serverUrl={SERVER_URL} />
        </Flex>
      </div>
    </ConfigProvider>
  );
}

export default App;
