"""What is selected in the viewer reaches the agent: once per conversation, from its own project, by real paths."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cadgen.viewer import agent_context
from cadgen.viewer.agent_context import AgentContext
from .test_http_layer import ServerFixture

HEADERS = {'x-cadgen-viewer': '1', 'Content-Type': 'application/json'}


class Project:
    """A project whose parts the viewer serves through a titled symlink, as tools/preview.sh does."""

    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(os.path.realpath(self.tmp.name)) / 'repo'
        self.part = self.root / 'projects' / 'stand' / 'export' / 'mini.stl'
        self.part.parent.mkdir(parents=True)
        self.part.write_text('solid', encoding='utf-8')
        (self.root / 'preview').mkdir()
        (self.root / 'preview' / 'Food Label').symlink_to(self.part.parent)
        self.served = str(self.root / 'preview' / 'Food Label' / 'mini.stl')
        self.elsewhere = Path(os.path.realpath(self.tmp.name)) / 'other' / 'part.stl'
        self.elsewhere.parent.mkdir()
        self.elsewhere.write_text('solid', encoding='utf-8')

    def close(self):
        self.tmp.cleanup()


class AgentContextTests(unittest.TestCase):
    def setUp(self):
        self.project = Project()
        self.addCleanup(self.project.close)
        self.now = 1000.0
        self.context = AgentContext(clock=lambda: self.now)
        self.cwd = str(self.project.root)

    def publish(self, text, tab='tab-1', paths=None):
        return self.context.publish(tab, text, [self.project.served] if paths is None else paths)

    def texts(self, session='session-1', cwd=None):
        return [item['text'] for item in self.context.read(session, cwd or self.cwd)]

    def test_a_conversation_reads_a_selection_once(self):
        self.publish('the top face')
        self.assertEqual(self.texts(), ['the top face'])
        self.assertEqual(self.texts(), [])

    def test_one_conversation_reading_does_not_take_it_from_another(self):
        self.publish('the top face')
        self.assertEqual(self.texts('session-1'), ['the top face'])
        self.assertEqual(self.texts('session-2'), ['the top face'])

    def test_a_changed_selection_is_read_again(self):
        self.publish('the top face')
        self.texts()
        self.publish('the top face and an edge')
        self.assertEqual(self.texts(), ['the top face and an edge'])

    def test_publishing_the_same_selection_again_is_not_new(self):
        self.publish('the top face')
        self.texts()
        self.publish('the top face')
        self.assertEqual(self.texts(), [])

    def test_clearing_a_selection_leaves_nothing_to_read(self):
        self.publish('the top face')
        self.publish('', paths=[])
        self.assertEqual(self.texts(), [])

    def test_two_tabs_keep_their_own_selection(self):
        self.publish('from one', tab='tab-1')
        self.publish('from two', tab='tab-2')
        self.publish('', tab='tab-1', paths=[])
        self.assertEqual(self.texts(), ['from two'])

    def test_served_symlink_paths_become_the_real_ones(self):
        self.publish(f'face of {self.project.served}')
        self.assertEqual(self.texts(), [f'face of {self.project.part}'])

    def test_a_selection_outside_the_conversations_project_stays_out(self):
        self.publish('elsewhere', paths=[str(self.project.elsewhere)])
        self.assertEqual(self.texts(), [])
        self.assertEqual(self.texts(cwd=str(self.project.elsewhere.parent)), ['elsewhere'])

    def test_a_forgotten_selection_expires(self):
        self.publish('the top face')
        self.now += agent_context.TTL_SECONDS + 1
        self.assertEqual(self.texts(), [])

    def test_status_says_when_the_selection_has_gone(self):
        self.publish('the top face')
        self.assertEqual(self.context.status('tab-1')['delivered'], False)
        self.texts()
        self.assertEqual(self.context.status('tab-1')['delivered'], True)
        self.publish('another face')
        self.assertEqual(self.context.status('tab-1')['delivered'], False)
        self.assertEqual(self.context.status('never-published')['delivered'], False)

    def test_the_oldest_tab_gives_way(self):
        for number in range(agent_context.MAX_TABS + 1):
            self.publish(f'selection {number}', tab=f'tab-{number}')
            self.now += 1
        texts = self.texts()
        self.assertEqual(len(texts), agent_context.MAX_TABS)
        self.assertNotIn('selection 0', texts)


class AgentContextRouteTests(unittest.TestCase):
    def setUp(self):
        self.project = Project()
        self.addCleanup(self.project.close)
        flag = mock.patch.dict(os.environ, {agent_context.ENV: '1'})
        flag.start()
        self.addCleanup(flag.stop)
        self.server = ServerFixture()
        self.addCleanup(self.server.close)

    def post(self, path, payload, headers=HEADERS):
        return self.server.request('POST', path, headers=headers, body=json.dumps(payload).encode())

    def publication(self, text='the top face'):
        return {'tab': 'tab-1', 'text': text, 'paths': [self.project.served]}

    def test_the_browser_guard_applies(self):
        self.assertEqual(self.post('/__cad/context', self.publication(), headers={})[0], 403)
        self.assertEqual(self.post('/__cad/context/read', {'session': 's', 'cwd': '/'}, headers={})[0], 403)

    def test_published_then_read_over_http(self):
        self.assertEqual(self.post('/__cad/context', self.publication())[0], 200)
        status, _, body = self.post('/__cad/context/read', {'session': 's', 'cwd': str(self.project.root)})
        self.assertEqual(status, 200)
        self.assertEqual([item['text'] for item in json.loads(body)['items']], ['the top face'])

    def test_status_over_http(self):
        self.post('/__cad/context', self.publication())
        status, _, body = self.server.request('GET', '/__cad/context?tab=tab-1')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['delivered'], False)

    def test_malformed_and_oversized_publications_are_refused(self):
        self.assertEqual(self.post('/__cad/context', {'tab': 'tab-1'})[0], 400)
        self.assertEqual(self.post('/__cad/context', {'tab': 1, 'text': '', 'paths': []})[0], 400)
        self.assertEqual(self.post('/__cad/context', self.publication('x' * (agent_context.MAX_BODY_BYTES + 1)))[0], 413)

    def test_the_server_says_the_feature_is_on(self):
        _, _, body = self.server.request('GET', '/__cad/server')
        self.assertIs(json.loads(body)['agentContext'], True)

    def test_context_routes_do_not_hold_back_a_restart(self):
        from cadgen.viewer.http_app import _UNCOUNTED_ROUTES
        self.assertLessEqual({'/__cad/context', '/__cad/context/read'}, _UNCOUNTED_ROUTES)


class AgentContextOffTests(unittest.TestCase):
    def test_without_the_flag_the_routes_do_not_exist(self):
        with mock.patch.dict(os.environ):
            os.environ.pop(agent_context.ENV, None)
            server = ServerFixture()
            self.addCleanup(server.close)
            self.assertEqual(server.request('GET', '/__cad/context?tab=t')[0], 404)
            self.assertEqual(server.request('POST', '/__cad/context', headers=HEADERS, body=b'{}')[0], 405)
            self.assertNotIn('agentContext', json.loads(server.request('GET', '/__cad/server')[2]))
