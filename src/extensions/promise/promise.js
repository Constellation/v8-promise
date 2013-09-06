// Copyright 2013 the V8 project authors. All rights reserved.
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are
// met:
//
//     * Redistributions of source code must retain the above copyright
//       notice, this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above
//       copyright notice, this list of conditions and the following
//       disclaimer in the documentation and/or other materials provided
//       with the distribution.
//     * Neither the name of Google Inc. nor the names of its
//       contributors may be used to endorse or promote products derived
//       from this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
// OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
// LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
// THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
// limitations under the License.

var Promise = (function () {
  'use strict';

  var $Promise = global.$Promise,
      INTERNAL = %CreateSymbol('internal'),
      ThenableCoercions;

  ThenableCoercions = $WeakMap();

  function InitializePromise(promise, resolver) {
    if (!%_IsObject(promise)) {
      throw %MakeTypeError('cannot_convert_to_primitive', []);
    }

    var internal = { __proto__: null };
    internal.derived = new InternalArray();

    promise[INTERNAL] = internal;

    return promise;
  }

  function IsPromise(promise) {
    if (!%_IsObject(promise)) return false;
    return promise[INTERNAL] != null;
  }


  function ToPromise(x) {
    if (IsPromise(x)) return x;
    var p = new $Promise();
    Resolve(p, x);
    return p;
  }

  function Resolve(p, x) {
    var pi = p[INTERNAL];
    var xi = x[INTERNAL];
    if (%HasLocalProperty(pi, 'following') ||
        %HasLocalProperty(pi, 'value') ||
        %HasLocalProperty(pi, 'reason')) return;
    if (IsPromise(x)) {
      if (SameValue(p, x)) {
        SetReason(p, %MakeTypeError('cannot_convert_to_primitive', []));
      } else if (%HasLocalProperty(xi, 'following')) {
        pi.following = xi.following;
        xi.following[INTERNAL].derived.push({
          derivedPromise: p,
          onFulfilled: undefined,
          onRejected: undefined
        });
      } else if (%HasLocalProperty(xi, 'value')) {
        SetValue(p, xi.value);
      } else if (%HasLocalProperty(xi, 'reason')) {
        SetReason(p, xi.reason);
      } else {
        pi.following = x;
        xi.derived.push({
          derivedPromise: p,
          onFulfilled: undefined,
          onRejected: undefined
        });
      }
    } else {
      SetValue(p, x);
    }
  }

  function Reject(p, r) {
    var pi = p[INTERNAL];
    if (%HasLocalProperty(pi, 'following') ||
        %HasLocalProperty(pi, 'value') ||
        %HasLocalProperty(pi, 'reason')) return;
    SetReason(p, r);
  }

  function Then(p, onFulfilled, onRejected) {
    var pi = p[INTERNAL];
    if (%HasLocalProperty(pi, 'following')) {
      return Then(pi.following, onFulfilled, onRejected);
    }
    var q = new $Promise();
    var derived = {
      derivedPromise: q,
      onFulfilled: onFulfilled,
      onRejected: onRejected
    };
    UpdateDerivedFromPromise(derived, p);
    return q;
  }

  function PropagateToDerived(p) {
    var pi = p[INTERNAL];
    var derived = pi.derived;
    for (var i = 0, iz = derived.length; i < iz; ++i) {
      UpdateDerived(derived[i], p);
    }
    pi.derived = new InternalArray();
  }

  function UpdateDerived(derived, originator) {
    var oi = originator[INTERNAL];
    if (%HasLocalProperty(oi, 'value')) {
      if (%_IsObject(oi.value)) {
        %QueuePromiseMicroTask(function () {
          if (%WeakCollectionHas(ThenableCoercions, oi.value)) {
            var coerced_already = %WeakCollectionGet(ThenableCoercions, oi.value);
            UpdateDerivedFromPromise(derived, coerced_already);
          } else {
            try {
              var then = oi.value.then;
            } catch (e) {
              UpdateDerivedFromReason(derived, e);
              return;
            }
            if (IS_FUNCTION(then)) {
              var coerced = CoerceThenable(oi.value, then);
              UpdateDerivedFromPromise(derived, coerced);
            } else {
              UpdateDerivedFromValue(derived, oi.value);
            }
          }
        });
      } else {
        UpdateDerivedFromValue(derived, oi.value);
      }
    } else {
      UpdateDerivedFromReason(derived, oi.reason);
    }
  }

  function UpdateDerivedFromValue(derived, value) {
    if (IS_FUNCTION(derived.onFulfilled)) {
      CallHandler(derived.derivedPromise, derived.onFulfilled, value);
    } else {
      SetValue(derived.derivedPromise, value);
    }
  }

  function UpdateDerivedFromReason(derived, reason) {
    if (IS_FUNCTION(derived.onRejected)) {
      CallHandler(derived.derivedPromise, derived.onRejected, reason);
    } else {
      SetReason(derived.derivedPromise, reason);
    }
  }

  function UpdateDerivedFromPromise(derived, promise) {
    var pi = promise[INTERNAL];
    if (%HasLocalProperty(pi, 'value') || %HasLocalProperty(pi, 'reason')) {
      UpdateDerived(derived, promise);
    } else {
      pi.derived.push(derived);
    }
  }

  function CallHandler(derivedPromise, handler, argument) {
    %QueuePromiseMicroTask(function () {
      try {
        var v = handler(argument);
      } catch (e) {
        Reject(derivedPromise, e);
        return;
      }
      Resolve(derivedPromise, v);
    });
  }

  function SetValue(p, value) {
    var pi = p[INTERNAL];
    pi.value = value;
    delete pi.following;
    PropagateToDerived(p);
  }

  function SetReason(p, reason) {
    var pi = p[INTERNAL];
    pi.reason = reason;
    delete pi.following;
    PropagateToDerived(p);
  }

  function CoerceThenable(thenable, then) {
    var p = new $Promise();

    function resolve(x) {
      Resolve(p, x);
    }

    function reject(x) {
      Reject(p, x);
    }

    try {
      then(thenable, resolve, reject);
    } catch (e) {
      Reject(p, e);
    }
    %WeakCollectionSet(thenable, p);
    return p;
  }

  /**
   * Constructs Promise object given a resolver.
   *
   * @constructor
   */
  function PromiseConstructor(resolver) {
    if (!%_IsConstructCall()) {
    }
    return InitializePromise(this, resolver);
  }

  function PromiseThen(onFulfilled, onRejected) {
    if (!IsPromise(this)) {
      throw %MakeTypeError('cannot_convert_to_primitive', []);
    }
    return Then(this, onFulfilled, onRejected);
  }

  function PromiseCatch(onRejected) {
    if (!IsPromise(this)) {
      throw %MakeTypeError('cannot_convert_to_primitive', []);
    }
    return Then(this, undefined, onRejected);
  }

  function PromiseResolve(x) {
    var p = new $Promise();
    Resolve(p, x);
    return p;
  }

  function PromiseReject(x) {
    var p = new $Promise();
    Reject(p, r);
    return p;
  }

  function PromiseCast(x) {
    return ToPromise(x);
  }

  function PromiseRace(iterable) {
    var returned_promise = new $Promise();

    function resolve(x) {
      // FIXME(Yusuke Suzuki): spec bug
      Resolve(returned_promise, x);
    }

    function reject(x) {
      // FIXME(Yusuke Suzuki): spec bug
      Reject(returned_promise, x);
    }

    // FIXME(Yusuke Suzuki): iterable
    for (var i = 0, iz = iterable.length; i < iz; ++i) {
      var next_promise = ToPromise(iterable[i]);
      Then(next_promise, resolve, reject);
    }

    return returned_promise;
  }

  function PromiseAll(iterable) {
    var values_promise = new $Promise();

    function rejectValuesPromise(r) {
      Reject(values_promise, r);
    }

    var values = new InternalArray();
    var countdown = 0;

    // FIXME(Yusuke Suzuki): iterable
    for (var index = 0, iz = iterable.length; i < iz; ++i) {
      (function () {
        var current_index = index;
        var next_promise = ToPromise(iterable[i]);
        function onFulfilled(v) {
          values[current_index] = v;
          if (!--countdown) {
            var result = new $Array();
            %MoveArrayContents(values, result);
            Resolve(values_promise, result);
          }
        }
        Then(next_promise, onFulfilled, rejectValuesPromise);
        ++index;
        ++countdown;
      }());
    }

    // FIXME(Yusuke Suzuki): emptyPromise
    if (index === 0) {
      Resolve(values_promise, new $Array());
    }

    return values_promise;
  }

  //-------------------------------------------------------------------

  function SetUpPromise() {
    %SetCode($Promise, PromiseConstructor);
    %FunctionSetPrototype($Promise, {});
    %SetProperty($Promise.prototype, "constructor", $Promise, DONT_ENUM);

    InstallFunctions($Promise, DONT_ENUM, $Array(
      "resolve", PromiseResolve,
      "reject", PromiseReject,
      "cast", PromiseCast,
      "race", PromiseRace,
      "all", PromiseAll
    ));

    InstallFunctions($Promise.prototype, DONT_ENUM, $Array(
      "then", PromiseThen,
      "catch", PromiseCatch
    ));
  }

  SetUpPromise();

  return $Promise;
}());
/* vim: set sw=2 ts=2 et tw=80 : */
