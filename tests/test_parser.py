import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from backend.xlsx_parser import hex_to_rgb, get_marker_class, is_black


def test_hex_to_rgb_none():
    assert hex_to_rgb(None) is None


def test_hex_to_rgb_string():
    assert hex_to_rgb('abcd') == 'ABCD'
    assert hex_to_rgb('#FF00AA') == '#FF00AA'  # function does not strip #, just upper
    # Actually function just returns upper if string, so '#ff00aa' -> '#FF00AA'
    assert hex_to_rgb('#ff00aa') == '#FF00AA'


def test_hex_to_rgb_object_with_rgb():
    # Mock object with rgb attribute
    class MockColor:
        def __init__(self, rgb):
            self.rgb = rgb

    # 8-digit ARGB
    argb = MockColor('00112233')
    assert hex_to_rgb(argb) == '112233'
    # 6-digit RGB (no alpha)
    rgb = MockColor('aabbcc')
    assert hex_to_rgb(rgb) == 'AABBCC'
    # Ensure upper
    assert hex_to_rgb(MockColor('aBcDeF')) == 'ABCDEF'


def test_get_marker_class_none():
    assert get_marker_class(None) is None


def test_get_marker_class_known():
    assert get_marker_class('FF0000') == 'marker-red'
    assert get_marker_class('ff0000') == 'marker-red'  # case-insensitive
    assert get_marker_class('00B050') == 'marker-green'
    assert get_marker_class('00b050') == 'marker-green'


def test_get_marker_class_unknown():
    assert get_marker_class('123456') is None
    assert get_marker_class('FFFFFF') is None  # white not in mapping
    assert get_marker_class('000000') is None  # black not in mapping


def test_is_black_none():
    assert is_black(None) is True


def test_is_black_true_cases():
    assert is_black('000000') is True
    assert is_black('FF000000') is True
    assert is_black('0D0D0D') is True
    # also test lower-case
    assert is_black('0d0d0d') is True


def test_is_black_false_cases():
    assert is_black('FFFFFF') is False
    assert is_black('ffffff') is False
    assert is_black('FF0000') is False  # red
    assert is_black('00B050') is False  # green