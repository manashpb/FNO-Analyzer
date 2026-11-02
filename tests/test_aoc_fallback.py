import sys
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from fno_analyzer.providers.aoc import AocClient, V27_SERVERS
from fno_analyzer.errors import ProviderError, ProviderAuthError


class FallbackTests(unittest.TestCase):
    def client(self, **config):
        return AocClient({'providers': {'aoc': {'api_mode': 'v27',
            'base_url': 'https://legacy.invalid', 'token': 'test', **config}},
            'server': {}, 'cache': {}})

    def response(self, status=200):
        return Mock(status_code=status, headers={}, json=Mock(return_value={'data': []}))

    @patch('fno_analyzer.providers.aoc.time.sleep')
    def test_connection_and_5xx_fallback_remember_working_server(self, sleep):
        for failure in (requests.ConnectTimeout(), requests.ConnectionError(), self.response(503)):
            client = self.client()
            client.session.get = Mock(side_effect=[failure, self.response(), self.response()])
            client._request('historical', {'ticker': 'NIFTY'})
            client._request('live', {'symbol': 'NIFTY'})
            calls = client.session.get.call_args_list
            self.assertEqual([c.args[0].split('/api/')[0] for c in calls],
                             [V27_SERVERS[0].split('/api/')[0], *[V27_SERVERS[1].split('/api/')[0]] * 2])
            self.assertEqual(calls[1].kwargs['params'], {'ticker': 'NIFTY'})
            self.assertEqual(calls[0].kwargs['timeout'], (5.0, 30.0))
            self.assertIn(V27_SERVERS[0], client._failed_servers)

    def test_auth_rate_limits_and_not_found_never_switch(self):
        for status in (401, 403, 404, 429):
            client = self.client()
            client.session.get = Mock(return_value=self.response(status))
            with self.assertRaises(ProviderError):
                client._request('tickers')
            self.assertEqual(client.session.get.call_count, 1)
            if status == 429:
                self.assertGreater(client._cooldown_until, 0)

    @patch('fno_analyzer.providers.aoc.time.sleep')
    def test_all_down_bounded_and_cooldown_recovers(self, sleep):
        client = self.client()
        client.session.get = Mock(side_effect=requests.ConnectionError())
        for _ in range(2):
            with self.assertRaises(ProviderError):
                client._request('tickers')
        self.assertEqual(client.session.get.call_count, 2)
        client._failed_servers = {s: 0 for s in V27_SERVERS}
        client.session.get.side_effect = None
        client.session.get.return_value = self.response()
        client._request('tickers')
        self.assertEqual(client._active_server, V27_SERVERS[0])

    def test_custom_server_does_not_receive_implicit_mirror(self):
        client = self.client(v27_base_url='https://custom.invalid/api/v27')
        client.session.get = Mock(side_effect=requests.ConnectionError())
        with self.assertRaises(ProviderError):
            client._request('tickers')
        self.assertEqual(client.session.get.call_count, 1)

    def test_alternate_primary_can_fail_back(self):
        client = self.client(v27_base_url=V27_SERVERS[1])
        client._last_request = -100
        client.session.get = Mock(side_effect=[requests.ConnectionError(), self.response()])
        with patch('fno_analyzer.providers.aoc.time.sleep'):
            client._request('expiries')
        self.assertEqual(client._active_server, V27_SERVERS[0])
